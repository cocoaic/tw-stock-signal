// 名人持股：台股內部人事前申報轉讓（證交所／櫃買中心 OpenAPI）、美國企業內部人 Form 4（OpenInsider）、
// 美國眾議員交易申報清單（House Clerk 官方年度索引）、大型投資人 13F 持股（Dataroma）。
'use strict';
const zlib = require('zlib');

module.exports = function createCeleb(ctx) {
  const { toNum, log } = ctx;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const cache = new Map(), inflight = new Map();
  async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) return c;
    if (inflight.has(key)) return c || inflight.get(key);
    const p = (async () => {
      try { const v = { at: Date.now(), data: await fn(), error: null }; cache.set(key, v); return v; }
      catch (e) { log('名人持股資料失敗', key, e.message); const v = { at: Date.now() - ttl + 5 * 60000, data: c ? c.data : null, error: e.message }; cache.set(key, v); return v; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  async function get(url, type = 'text') {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return type === 'json' ? r.json() : type === 'buf' ? Buffer.from(await r.arrayBuffer()) : r.text();
  }
  const strip = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  function htmlTable(html, startMarker) {
    const i = html.indexOf(startMarker); if (i < 0) return null;
    const end = html.indexOf('</table>', i); const t = html.slice(i, end);
    const heads = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => strip(m[1]));
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1]))).filter(r => r.length >= 3);
    return { heads, rows };
  }
  const col = (heads, ...names) => heads.findIndex(h => names.some(n => h.toLowerCase().replace(/\s/g, '').includes(n.toLowerCase().replace(/\s/g, ''))));

  // ---------- 台股：內部人持股轉讓事前申報（從 swagger 找出正確路徑）----------
  async function findPath(base, mustAll) {
    const sw = await get(base + '/swagger.json', 'json');
    for (const [p, def] of Object.entries(sw.paths || {})) {
      const s = JSON.stringify(def);
      if (mustAll.every(k => s.includes(k))) return p;
    }
    return null;
  }
  function parseTransfer(list, market) {
    const v = (r, ...ks) => { for (const [k, val] of Object.entries(r)) if (ks.every(x => k.includes(x))) return val; return null; };
    return (Array.isArray(list) ? list : []).map(r => {
      const shares = toNum(v(r, '轉讓股數')) ?? toNum(v(r, '預定轉讓總股數', '自有'));
      const own = toNum(v(r, '目前持有股數', '自有'));
      return { market, date: String(v(r, '出表日期') || v(r, '申報日期') || ''), code: String(v(r, '公司代號') || '').trim(), name: String(v(r, '公司名稱') || '').trim(),
        role: String(v(r, '申請人身分') || v(r, '身分') || '').trim(), person: String(v(r, '姓名') || '').trim(), method: String(v(r, '轉讓方式') || '').trim(),
        lots: shares != null ? Math.round(shares / 1000) : null, ownLots: own != null ? Math.round(own / 1000) : null,
        pct: shares && own ? +(shares / own * 100).toFixed(1) : null, transferee: String(v(r, '受讓人') || '').trim(), period: String(v(r, '有效轉讓期間') || v(r, '轉讓期間') || '').trim() };
    }).filter(x => x.code);
  }
  async function twInsiders() {
    return (await cached('tw', 60 * 60000, async () => {
      const out = [], errs = [];
      for (const [base, market] of [['https://openapi.twse.com.tw/v1', '上市'], ['https://www.tpex.org.tw/openapi/v1', '上櫃']]) {
        try {
          const p = await findPath(base, ['事前申報', '轉讓日報']);
          if (!p) throw new Error('找不到資料集');
          out.push(...parseTransfer(await get(base + p, 'json'), market));
        } catch (e) { errs.push(market + '：' + e.message); }
      }
      if (!out.length && errs.length) throw new Error(errs.join('；'));
      out.sort((a, b) => (b.lots || 0) - (a.lots || 0));
      return { items: out, partialErrors: errs };
    }));
  }

  // ---------- 美國：企業內部人 Form 4（OpenInsider）----------
  function parseOpenInsider(html) {
    const t = htmlTable(html, 'class="tinytable"'); if (!t) return [];
    const H = t.heads, i = n => col(H, ...n);
    const iF = i(['Filing Date', 'FilingDate']), iT = i(['Trade Date', 'TradeDate']), iK = i(['Ticker']), iC = i(['Company Name', 'Company']), iN = i(['Insider Name', 'Insider']),
      iTi = i(['Title']), iTy = i(['Trade Type', 'TradeType']), iP = i(['Price']), iQ = i(['Qty']), iO = i(['Owned']), iD = i(['ΔOwn', 'Own']), iV = i(['Value']);
    return t.rows.map(r => {
      const g = k => k >= 0 ? r[k] : '';
      const filed = g(iF).slice(0, 10), traded = g(iT).slice(0, 10);
      return { filed, traded, delay: filed && traded ? Math.round((Date.parse(filed) - Date.parse(traded)) / 864e5) : null, ticker: g(iK), company: g(iC), insider: g(iN), title: g(iTi),
        type: g(iTy), price: g(iP), qty: g(iQ), owned: g(iO), dOwn: g(iD), value: g(iV) };
    }).filter(x => x.ticker && x.type);
  }
  async function usInsiders(ticker) {
    const t = String(ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 8);
    const url = t ? `http://openinsider.com/screener?s=${t}&fd=180&xp=1&xs=1&cnt=40&page=1` : 'http://openinsider.com/latest-insider-purchases-25k';
    return cached('oi:' + t, 30 * 60000, async () => ({ ticker: t || null, items: parseOpenInsider(await get(url)).slice(0, 40), url }));
  }

  // ---------- 美國：眾議員 PTR 申報清單（House Clerk 官方年度 zip 索引）----------
  function unzipFirstXml(buf) {
    let p = 0;
    while (p < buf.length - 30 && buf.readUInt32LE(p) === 0x04034b50) {
      const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
      const name = buf.slice(p + 30, p + 30 + nlen).toString(); const start = p + 30 + nlen + xlen; const data = buf.slice(start, start + csize);
      if (/\.xml$/i.test(name)) return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      p = start + csize;
    }
    throw new Error('zip 內找不到 XML');
  }
  async function houseFilings() {
    return cached('house', 6 * 3600e3, async () => {
      const y = new Date().getFullYear(), out = [];
      for (const yr of [y, y - 1]) {
        try {
          const xml = unzipFirstXml(await get(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${yr}FD.zip`, 'buf'));
          for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
            const g = t => { const x = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return x ? x[1].trim() : ''; };
            if (g('FilingType') !== 'P') continue; // P = 定期交易報告（PTR）
            const fd = g('FilingDate'), [mm, dd, yy] = fd.split('/');
            out.push({ name: [g('Prefix'), g('First'), g('Last'), g('Suffix')].filter(Boolean).join(' '), last: g('Last'), state: g('StateDst'), filed: yy ? `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : fd,
              pdf: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${g('Year') || yr}/${g('DocID')}.pdf` });
          }
          if (out.length > 60) break;
        } catch (e) { if (yr === y) log('眾議院索引失敗', yr, e.message); }
      }
      if (!out.length) throw new Error('無法讀取眾議院申報索引');
      const seen = new Set(), uniq = out.filter(x => !seen.has(x.pdf) && seen.add(x.pdf));
      uniq.sort((a, b) => b.filed.localeCompare(a.filed));
      return { items: uniq.slice(0, 400) };
    });
  }

  // ---------- 13F：大型投資人持股（Dataroma）----------
  const MANAGERS = { BRK: '波克夏（巴菲特）', psc: '潘興廣場（艾克曼）' };
  async function holdings13f(m) {
    const k = MANAGERS[m] ? m : 'BRK';
    return cached('13f:' + k, 12 * 3600e3, async () => {
      const html = await get(`https://www.dataroma.com/m/holdings.php?m=${k}`);
      const t = htmlTable(html, 'id="grid"'); if (!t) throw new Error('解析失敗');
      const H = t.heads, iS = col(H, 'Stock'), iP = col(H, '% of Portfolio', 'Portfolio'), iA = col(H, 'Recent Activity', 'Activity'), iSh = col(H, 'Shares'), iV = col(H, 'Value');
      const period = (html.match(/Period:\s*<b>([^<]+)<\/b>/) || html.match(/Portfolio date:\s*<b>([^<]+)<\/b>/) || [])[1] || '';
      return { manager: k, label: MANAGERS[k], period: strip(period), items: t.rows.map(r => ({ stock: r[iS] || '', pct: r[iP] || '', activity: r[iA] || '', shares: r[iSh] || '', value: r[iV] || '' })).filter(x => x.stock).slice(0, 30) };
    });
  }

  return { twInsiders, usInsiders, houseFilings, holdings13f, MANAGERS };
};
