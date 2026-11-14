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
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(25000) }); }
    catch (e) { const c = e.cause || {}; throw new Error(`連線失敗（${c.code || c.message || e.message}）`); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return type === 'json' ? r.json() : type === 'buf' ? Buffer.from(await r.arrayBuffer()) : r.text();
  }
  const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const strip = s => String(s || '').replace(TAG, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  function htmlTable(html, startMarker) {
    const i = html.indexOf(startMarker); if (i < 0) return null;
    const end = html.indexOf('</table>', i); const t = html.slice(i, end);
    const A = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    const heads = [...t.matchAll(new RegExp(`<th${A}>([\\s\\S]*?)<\\/th>`, 'g'))].map(m => strip(m[1]));
    const rows = [...t.matchAll(new RegExp(`<tr${A}>([\\s\\S]*?)<\\/tr>`, 'g'))].map(m => [...m[1].matchAll(new RegExp(`<td${A}>([\\s\\S]*?)<\\/td>`, 'g'))].map(c => strip(c[1]))).filter(r => r.length >= 3);
    // 有些網站的表頭用 <td> 而不是 <th>：沒有 <th> 時，把第一列當表頭
    if (!heads.length && rows.length) return { heads: rows[0], rows: rows.slice(1) };
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
      for (const [base, market] of [['https://openapi.twse.com.tw/v1', '上市']]) { // 櫃買中心擋海外伺服器，暫只抓上市
        try {
          const p = (await findPaths(base, s => s.includes('事前申報') && s.includes('轉讓日報') && !s.includes('未轉讓')))[0];
          if (!p) throw new Error('找不到資料集');
          out.push(...parseTransfer(await get(base + p.path, 'json'), market));
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
      iTi = i(['Title']), iTy = i(['Trade Type', 'TradeType']), iP = i(['Price']), iQ = i(['Qty']), iO = H.findIndex(h => h.trim() === 'Owned'), iD = H.findIndex(h => h.includes('Δ')), iV = i(['Value']);
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
    return cached('oi:' + t, 30 * 60000, async () => {
      const items = markInsiders(parseOpenInsider(await get(url)).slice(0, 40));
      if (!items.length && !t) throw new Error('網頁格式改變，讀不到交易表');
      return { ticker: t || null, items, url };
    });
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

  // ---------- 台股相關的美股代號（ADR 與台灣公司在美上市）----------
  const TW_US = {
    TSM: { code: '2330', name: '台積電', note: 'ADR' }, UMC: { code: '2303', name: '聯電', note: 'ADR' }, ASX: { code: '3711', name: '日月光投控', note: 'ADR' },
    CHT: { code: '2412', name: '中華電', note: 'ADR' }, HIMX: { code: null, name: '奇景光電', note: '台灣公司，只在美國上市' },
    SIMO: { code: null, name: '慧榮科技', note: '台灣公司，只在美國上市' }, EWT: { code: null, name: 'iShares MSCI 台灣 ETF', note: '追蹤台股的 ETF' }
  };
  const twOf = t => TW_US[String(t || '').toUpperCase().replace(/\s.*$/, '')] || null;

  // 誰持有台股相關標的：Dataroma 個股頁列出所有持有該股的知名投資人
  async function twHolders() {
    return cached('twh', 12 * 3600e3, async () => {
      const out = [], errs = [];
      for (const sym of Object.keys(TW_US)) {
        try {
          const html = await get(`https://www.dataroma.com/m/stock.php?sym=${sym}`);
          const t = htmlTable(html, 'id="grid"');
          if (!t) { continue; }
          const H = t.heads, iM = col(H, 'Portfolio Manager', 'Manager'), iP = H.findIndex(h => /^%|of portfolio/i.test(h.trim())), iA = col(H, 'Recent activity', 'activity'), iS = col(H, 'Shares'), iV = H.findIndex(h => /^Value/i.test(h.trim()));
          const holders = t.rows.map(r => ({ manager: r[iM >= 0 ? iM : 0] || '', pct: r[iP >= 0 ? iP : 1] || '', activity: iA >= 0 ? r[iA] || '' : '', shares: iS >= 0 ? r[iS] || '' : '', value: iV >= 0 ? r[iV] || '' : '' }))
            .filter(h => h.manager && /[A-Za-z]/.test(h.manager));
          if (holders.length) out.push({ sym, ...TW_US[sym], holders });
        } catch (e) { errs.push(sym + '：' + e.message); }
        await new Promise(r => setTimeout(r, 800)); // 對 Dataroma 客氣一點
      }
      if (!out.length && errs.length) throw new Error(errs.join('；'));
      return { items: out, partialErrors: errs };
    });
  }

  // ---------- 13F：大型投資人持股（Dataroma）----------
  const MANAGERS = { BRK: '波克夏（巴菲特）', psc: '潘興廣場（艾克曼）' };
  async function holdings13f(m) {
    const k = MANAGERS[m] ? m : 'BRK';
    return cached('13f:' + k, 12 * 3600e3, async () => {
      const html = await get(`https://www.dataroma.com/m/holdings.php?m=${k}`);
      const t = htmlTable(html, 'id="grid"'); if (!t) throw new Error('解析失敗');
      const H = t.heads, fb = (i, d) => i >= 0 ? i : d; // 找不到表頭時用 Dataroma 固定欄位順序
      const iS = fb(col(H, 'Stock'), 1), iP = fb(col(H, '% of Portfolio', 'Portfolio'), 2), iA = fb(col(H, 'Recent Activity', 'Activity'), 3), iSh = fb(col(H, 'Shares'), 4), iV = fb(H.findIndex(h => /^Value/i.test(h.trim())), 6);
      const period = (html.match(/Period:\s*<b>([^<]+)<\/b>/) || html.match(/Portfolio date:\s*<b>([^<]+)<\/b>/) || [])[1] || '';
      return { manager: k, label: MANAGERS[k], period: strip(period), items: (() => { const it = t.rows.map(r => ({ stock: r[iS] || '', pct: r[iP] || '', activity: r[iA] || '', shares: r[iSh] || '', value: r[iV] || '' })).filter(x => x.stock && /[A-Za-z]/.test(x.stock)).slice(0, 30);
        if (!it.length) throw new Error('網頁格式改變，讀不到持股表（表頭：' + H.slice(0, 6).join('/') + '）');
        it.forEach(x => { x.tw = twOf((x.stock.match(/^([A-Z.\-]+)/) || [])[1]); });
        return it.filter(x => x.tw).concat(it.filter(x => !x.tw)); })() };
    });
  }

  // ---------- 台股其他公開買賣資料（從 swagger 依關鍵字找資料集，欄位依名稱比對）----------
  async function findPaths(base, test) {
    const sw = await get(base + '/swagger.json', 'json');
    return Object.entries(sw.paths || {}).map(([p, def]) => { const op = def.get || Object.values(def)[0] || {}; return { path: p, summary: String(op.summary || '') + ' ' + String(op.description || '') }; })
      .filter(x => test(x.summary));
  }
  const DS = {
    monthly: { label: '董監事持股餘額明細', test: s => /董監事持股餘額明細/.test(s) && !/公發/.test(s) },
    pledge: { label: '董監事持股餘額明細', test: s => /董監事持股餘額明細/.test(s) && !/公發/.test(s) }
  };
  const kv = (r, ...need) => { for (const [k, v] of Object.entries(r)) if (need.every(n => k.includes(n))) return v; return null; };
  const num = v => { const n = toNum(v); return n == null ? null : n; };
  function mapRow(kind, r, market) {
    const base = { market, code: String(kv(r, '公司代號') || kv(r, '代號') || '').trim(), name: String(kv(r, '公司名稱') || kv(r, '名稱') || '').trim() };
    if (kind === 'monthly') {
      // 證交所只提供「選任時持股」與「目前持股」，所以這裡是上任以來的累計增減
      const prev = num(kv(r, '選任時持股')), now = num(kv(r, '目前持股'));
      const net = now != null && prev != null ? now - prev : null;
      return { ...base, ym: String(kv(r, '資料年月') || kv(r, '年月') || kv(r, '出表日期') || ''), role: String(kv(r, '職稱') || kv(r, '身分') || '').trim(), person: String(kv(r, '姓名') || '').trim(),
        netLots: net != null ? Math.round(net / 1000) : null, nowLots: now != null ? Math.round(now / 1000) : null, pct: net != null && prev ? +(net / prev * 100).toFixed(1) : null };
    }
    if (kind === 'buyback') {
      const plan = num(kv(r, '預定買回股數')) ?? num(kv(r, '預定買回')), done = num(kv(r, '已買回股數')) ?? num(kv(r, '累積已買回')) ?? num(kv(r, '執行'));
      return { ...base, date: String(kv(r, '董事會決議日') || kv(r, '決議日') || kv(r, '出表日期') || ''), purpose: String(kv(r, '目的') || '').trim(),
        planLots: plan != null ? Math.round(plan / 1000) : null, doneLots: done != null ? Math.round(done / 1000) : null,
        priceLow: num(kv(r, '最低')), priceHigh: num(kv(r, '最高')), period: String(kv(r, '期間') || '').trim() };
    }
    const hold = num(kv(r, '目前持股')) ?? num(kv(r, '持有股數')), pl = num(kv(r, '設質股數')) ?? num(kv(r, '質押股數'));
    const ratio = num(kv(r, '設質股數佔持股比例')) ?? num(kv(r, '質押比例')) ?? (hold && pl != null ? +(pl / hold * 100).toFixed(1) : null);
    return { ...base, role: String(kv(r, '職稱') || kv(r, '身分') || '').trim(), person: String(kv(r, '姓名') || '').trim(), holdLots: hold != null ? Math.round(hold / 1000) : null, pledgeLots: pl != null ? Math.round(pl / 1000) : null, ratio };
  }
  const seenKeys = new Set();
  async function twData(kind) {
    const cfg = DS[kind]; if (!cfg) throw new Error('未知類別');
    return (await cached('twd:' + kind, 3 * 3600e3, async () => {
      const out = [], errs = [], used = [];
      for (const [base, market] of [['https://openapi.twse.com.tw/v1', '上市']]) {
        try {
          const paths = await findPaths(base, cfg.test);
          if (!paths.length) throw new Error('找不到' + cfg.label + '資料集');
          const pick = paths[0]; used.push(market + '：' + pick.summary);
          const list = await get(base + pick.path, 'json');
          if (Array.isArray(list) && list[0] && !seenKeys.has(kind + market)) { seenKeys.add(kind + market); log('資料集欄位', kind, market, pick.path, Object.keys(list[0]).join('|')); }
          out.push(...(Array.isArray(list) ? list : []).map(r => mapRow(kind, r, market)).filter(x => x.code));
        } catch (e) { errs.push(market + '：' + e.message); }
      }
      if (!out.length && errs.length) throw new Error(errs.join('；'));
      if (kind === 'monthly') out.sort((a, b) => Math.abs(b.netLots || 0) - Math.abs(a.netLots || 0));
      if (kind === 'buyback') out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      if (kind === 'pledge') out.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
      return { items: out.filter(x => kind === 'monthly' ? x.netLots : kind === 'pledge' ? x.pledgeLots > 0 : true), sources: used, partialErrors: errs };
    }));
  }

  // ---------- 大戶持股趨勢（集保股權分散表，FinMind 週資料）----------
  async function holders(code) {
    return cached('hold:' + code, 12 * 3600e3, async () => {
      const start = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
      const headers = { Accept: 'application/json' }; if (process.env.FINMIND_TOKEN) headers.Authorization = 'Bearer ' + process.env.FINMIND_TOKEN;
      const r = await fetch(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockHoldingSharesPer&data_id=${code}&start_date=${start}`, { headers, signal: AbortSignal.timeout(20000) });
      const j = await r.json(); if (!r.ok || !Array.isArray(j.data)) throw new Error(j.msg || 'HTTP ' + r.status);
      const by = {};
      for (const x of j.data) {
        const d = by[x.date] = by[x.date] || { date: x.date, big: 0, small: 0, people: 0, bigPeople: 0 };
        const lv = String(x.HoldingSharesLevel || '');
        if (/^1,000,001/.test(lv) || /more than 1,000,001/i.test(lv) || /^1000001/.test(lv)) { d.big += +x.percent || 0; d.bigPeople += +x.people || 0; }
        if (/^(1-999|1,000-5,000|5,001-10,000)$/.test(lv.replace(/\s/g, ''))) d.small += +x.percent || 0;
        if (/^total/i.test(lv)) d.people = +x.people || 0;
      }
      const weeks = Object.values(by).sort((a, b) => a.date < b.date ? -1 : 1).slice(-10).map(w => ({ ...w, big: +w.big.toFixed(2), small: +w.small.toFixed(2) }));
      if (!weeks.length) throw new Error('查無集保資料');
      return { weeks };
    });
  }

  function markInsiders(items) { items.forEach(x => { x.tw = twOf(x.ticker); }); return items.filter(x => x.tw).concat(items.filter(x => !x.tw)); }
  async function discover() {
    for (const base of ['https://openapi.twse.com.tw/v1']) {
      try {
        const list = await findPaths(base, s => /持股|董|監察|庫藏|質|轉讓|異動|大股東|經理人|內部人/.test(s));
        log('資料集清單', base, list.map(x => x.path + '=' + x.summary.trim().slice(0, 40)).join(' ｜ '));
      } catch (e) { log('資料集清單失敗', base, e.message); }
    }
  }
  return { TW_US, twOf, twHolders, discover, twInsiders, twData, holders, usInsiders, houseFilings, holdings13f, MANAGERS };
};
