// 各市場行情：台股排行、ETF、台股類股指數、期貨、選擇權、權證、美股、日股。
// 來源：證交所（OpenAPI、每日收盤行情、即時 MIS）、期交所行情系統、Yahoo Finance。
'use strict';

module.exports = function createQuotes(ctx) {
  const { getJSON, toNum, ymd, tpeNow, isMarketTime, mkt, scan, log } = ctx;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const cache = new Map(), inflight = new Map();
  async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) return c;
    if (inflight.has(key)) return c || inflight.get(key);
    const p = (async () => {
      try { const v = { at: Date.now(), data: await fn(), error: null }; cache.set(key, v); return v; }
      catch (e) { log('行情失敗', key, e.message); const v = { at: Date.now() - ttl + 60000, data: c ? c.data : null, error: e.message }; cache.set(key, v); return v; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return c || p;
  }
  const r2 = v => v == null || !isFinite(v) ? null : +(+v).toFixed(2);
  const tradingDates = n => { const out = [], t = tpeNow(); for (let i = 0; out.length < n && i < 14; i++) { const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i); if (i === 0 && t.getHours() < 15) continue; if (d.getDay() % 6 === 0) continue; out.push(ymd(d)); } return out; };
  const findTable = (j, must) => { const ts = []; if (Array.isArray(j.tables)) ts.push(...j.tables); for (let i = 1; i <= 9; i++) if (j['fields' + i]) ts.push({ fields: j['fields' + i], data: j['data' + i] }); if (j.fields) ts.push({ fields: j.fields, data: j.data }); return ts.filter(t => Array.isArray(t.fields) && must.every(m => t.fields.some(f => String(f).includes(m))) && Array.isArray(t.data)); };
  const colOf = (f, n) => f.findIndex(x => String(x).includes(n));

  // ---------- 證交所即時（MIS），一次最多 50 檔 ----------
  async function mis(exch) {
    const out = {};
    for (let i = 0; i < exch.length; i += 50) {
      const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exch.slice(i, i + 50).join('|')}&json=1&delay=0&_=${Date.now()}`);
      for (const q of j.msgArray || []) {
        const b = toNum(String(q.b || '').split('_')[0]), a = toNum(String(q.a || '').split('_')[0]);
        const price = toNum(q.z) ?? (b != null && a != null ? (a + b) / 2 : b ?? a), prev = toNum(q.y);
        out[q.c] = { price, prev, chg: price && prev ? r2((price - prev) / prev * 100) : null, vol: toNum(q.v), time: q.t };
      }
    }
    return out;
  }

  // ---------- 台股排行（上市普通股）----------
  function twRank() {
    const live = isMarketTime(), rows = [];
    for (const s of mkt.M.stocks.values()) {
      const c = s.calc; if (!c || !c.price) continue;
      const L = live ? scan.live[s.code] : null;
      const price = L && L.price ? L.price : c.price, prev = L && L.prev ? L.prev : c.prev;
      rows.push({ code: s.code, name: s.name, industry: s.industry, price, chg: price && prev ? r2((price - prev) / prev * 100) : c.chg, value: c.value, vol: L && L.vol != null ? L.vol : c.vol, live: !!L });
    }
    const pick = (cmp, k = 30) => rows.slice().sort(cmp).slice(0, k);
    return { live, asOf: mkt.M.days[mkt.M.days.length - 1] || null, gainers: pick((a, b) => b.chg - a.chg), losers: pick((a, b) => a.chg - b.chg), active: pick((a, b) => b.value - a.value), volume: pick((a, b) => b.vol - a.vol), status: mkt.M.status };
  }

  // ---------- ETF ----------
  async function etf() {
    const base = (await cached('etfbase', 30 * 60000, async () => {
      const j = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
      const list = (Array.isArray(j) ? j : []).filter(r => /^00\d{2,4}[A-Z]?$/.test(String(r.Code).trim())).map(r => ({
        code: String(r.Code).trim(), name: String(r.Name).trim(), price: toNum(r.ClosingPrice), chgAbs: toNum(r.Change), value: toNum(r.TradeValue) || 0, vol: Math.round((toNum(r.TradeVolume) || 0) / 1000), date: r.Date }))
        .filter(r => r.price);
      list.forEach(r => { r.prev = r.chgAbs != null ? r.price - r.chgAbs : null; r.chg = r.prev ? r2(r.chgAbs / r.prev * 100) : null; });
      if (!list.length) throw new Error('查無 ETF 資料');
      return list.sort((a, b) => b.value - a.value);
    })).data || [];
    let rows = base.slice(0, 60);
    if (isMarketTime() && rows.length) {
      const live = (await cached('etflive', 60000, () => mis(rows.slice(0, 50).map(r => `tse_${r.code}.tw`)))).data || {};
      rows = rows.map(r => live[r.code] && live[r.code].price ? { ...r, price: live[r.code].price, chg: live[r.code].chg, live: true } : r);
    }
    const cat = n => /正2|槓桿/.test(n) ? 'leverage' : /反1|反向/.test(n) ? 'inverse' : /債|公司債|美債/.test(n) ? 'bond' : /高股息|高息|股息|優息/.test(n) ? 'dividend' : 'equity';
    return { live: isMarketTime(), rows: rows.map(r => ({ ...r, cat: cat(r.name) })) };
  }

  // ---------- 台股類股指數（證交所每日收盤）----------
  async function twIndices() {
    return (await cached('twidx', 30 * 60000, async () => {
      for (const date of tradingDates(5)) {
        let j = null;
        try { j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=IND&response=json`); } catch (e) { continue; }
        if (!j || j.stat !== 'OK') continue;
        const out = [];
        for (const t of findTable(j, ['指數', '收盤'])) {
          const f = t.fields, iN = 0, iC = colOf(f, '收盤'), iS = colOf(f, '漲跌(+/-)'), iP = colOf(f, '漲跌點數'), iR = colOf(f, '漲跌百分比');
          for (const r of t.data) {
            const name = String(r[iN]).replace(/<[^>]*>/g, '').trim(), v = toNum(r[iC]); if (!name || v == null) continue;
            const neg = String(r[iS]).includes('-'), pts = toNum(r[iP]), pct = toNum(r[iR]);
            out.push({ name, group: String(t.title || '').replace(/<[^>]*>/g, ''), value: v, change: pts != null ? (neg ? -pts : pts) : null, pct: pct != null ? (neg && pct > 0 ? -pct : pct) : null });
          }
        }
        if (out.length) return { date, rows: out.filter(x => !/報酬指數/.test(x.name)) };
      }
      throw new Error('找不到最近交易日的指數資料');
    })).data;
  }

  // ---------- 期交所行情（期貨、選擇權）----------
  async function taifex(body) {
    const r = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.RtData && j.RtData.QuoteList) || [];
  }
  const daySession = () => { const t = tpeNow(), m = t.getHours() * 60 + t.getMinutes(); return t.getDay() >= 1 && t.getDay() <= 5 && m >= 525 && m <= 825; };
  const FUT = [['TXF', '臺股期貨（大台）'], ['MXF', '小型臺指（小台）'], ['EXF', '電子期貨'], ['FXF', '金融期貨']];
  let logged = {};
  async function futures() {
    return (await cached('fut', 30000, async () => {
      const session = daySession() ? '0' : '1', rows = [];
      for (const [cid, label] of FUT) {
        try {
          const list = await taifex({ MarketType: session, SymbolType: 'F', KindID: '1', CID: cid, ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' });
          if (!logged[cid] && list[0]) { logged[cid] = 1; log('期貨欄位', cid, Object.keys(list[0]).join('|')); }
          const q = list.find(x => toNum(x.CLastPrice) != null && toNum(x.CRefPrice) != null) || list[0];
          if (!q) continue;
          const last = toNum(q.CLastPrice), ref = toNum(q.CRefPrice);
          rows.push({ cid, name: label, contract: q.DispCName || q.SymbolID, price: last, prev: ref, change: last != null && ref != null ? r2(last - ref) : null, pct: last && ref ? r2((last - ref) / ref * 100) : null,
            vol: toNum(q.CTotalVolume) ?? toNum(q.CVolume), oi: toNum(q.COpenInterest) ?? null, time: q.CTime || '' });
        } catch (e) { log('期貨失敗', cid, e.message); }
      }
      if (!rows.length) throw new Error('期交所行情暫時無法取得');
      return { session: session === '0' ? '日盤' : '夜盤', rows };
    })).data;
  }
  async function options() {
    return (await cached('opt', 60000, async () => {
      const session = daySession() ? '0' : '1';
      const list = await taifex({ MarketType: session, SymbolType: 'O', KindID: '1', CID: 'TXO', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' });
      if (!logged.TXO && list[0]) { logged.TXO = 1; log('選擇權欄位', Object.keys(list[0]).join('|'), JSON.stringify(list[0]).slice(0, 300)); }
      // 從代號或名稱解析履約價與買賣權：例如 TXO23500K6（K＝11 月買權）或名稱含「買權／賣權」
      const rows = list.map(x => {
        const sid = String(x.SymbolID || ''), name = String(x.DispCName || '');
        let strike = toNum(x.StrikePrice) ?? toNum((sid.match(/^TXO(\d{4,5})/) || [])[1]) ?? toNum((name.match(/(\d{4,5})/) || [])[1]);
        let cp = x.CallPut ? (/c|買/i.test(x.CallPut) ? 'C' : 'P') : /買權|Call/i.test(name) ? 'C' : /賣權|Put/i.test(name) ? 'P' : null;
        const ml = (sid.match(/^TXO\d{4,5}([A-X])/) || [])[1]; if (!cp && ml) cp = ml <= 'L' ? 'C' : 'P';
        const month = (name.match(/(\d{3}\/\d{2}(?:\s*W\d)?)/) || [])[1] || (ml ? ml : '');
        return { strike, cp, month, name, price: toNum(x.CLastPrice), prev: toNum(x.CRefPrice), vol: toNum(x.CTotalVolume) ?? toNum(x.CVolume), oi: toNum(x.COpenInterest) };
      }).filter(x => x.strike && x.cp);
      if (!rows.length) throw new Error('解析不到選擇權報價');
      const months = [...new Set(rows.map(r => r.month))]; const near = months[0];
      const nr = rows.filter(r => r.month === near);
      const fut = (await futures().catch(() => null)) || { rows: [] }, tx = fut.rows.find(r => r.cid === 'TXF');
      const center = tx && tx.price ? tx.price : nr.reduce((a, b) => a + b.strike, 0) / nr.length;
      const strikes = [...new Set(nr.map(r => r.strike))].sort((a, b) => Math.abs(a - center) - Math.abs(b - center)).slice(0, 13).sort((a, b) => a - b);
      const chain = strikes.map(k => ({ strike: k, call: nr.find(r => r.strike === k && r.cp === 'C') || null, put: nr.find(r => r.strike === k && r.cp === 'P') || null }));
      const cv = nr.filter(r => r.cp === 'C').reduce((a, b) => a + (b.vol || 0), 0), pv = nr.filter(r => r.cp === 'P').reduce((a, b) => a + (b.vol || 0), 0);
      const co = nr.filter(r => r.cp === 'C').reduce((a, b) => a + (b.oi || 0), 0), po = nr.filter(r => r.cp === 'P').reduce((a, b) => a + (b.oi || 0), 0);
      return { session: session === '0' ? '日盤' : '夜盤', month: near, center: r2(center), chain, pcVol: cv ? r2(pv / cv * 100) : null, pcOi: co ? r2(po / co * 100) : null };
    })).data;
  }

  // ---------- 權證（證交所每日收盤，認購 0999／認售 0999P）----------
  async function warrants() {
    return (await cached('war', 3600e3, async () => {
      for (const date of tradingDates(5)) {
        const out = {};
        for (const [type, kind] of [['0999', 'call'], ['0999P', 'put']]) {
          let j = null;
          try { j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=${type}&response=json`); } catch (e) { continue; }
          const t = j && j.stat === 'OK' ? findTable(j, ['證券代號', '收盤價'])[0] : null; if (!t) continue;
          const f = t.fields, iC = colOf(f, '證券代號'), iN = colOf(f, '證券名稱'), iV = colOf(f, '成交金額'), iQ = colOf(f, '成交股數'), iE = colOf(f, '收盤價'), iS = colOf(f, '漲跌(+/-)'), iP = colOf(f, '漲跌價差');
          out[kind] = t.data.map(r => { const price = toNum(r[iE]), d = toNum(r[iP]), neg = String(r[iS]).includes('-'); const ch = d != null ? (neg ? -d : d) : null;
            return { code: String(r[iC]).trim(), name: String(r[iN]).trim(), price, chg: price && ch != null && price - ch ? r2(ch / (price - ch) * 100) : null, value: toNum(r[iV]) || 0, vol: Math.round((toNum(r[iQ]) || 0) / 1000) }; })
            .filter(r => r.price && r.value > 0).sort((a, b) => b.value - a.value).slice(0, 400);
        }
        if (out.call || out.put) return { date, call: out.call || [], put: out.put || [] };
      }
      throw new Error('找不到最近交易日的權證資料');
    })).data;
  }

  // ---------- 美股、日股、全球期貨（Yahoo Finance）----------
  async function yahooOne(sym) {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json()).chart.result[0], m = res.meta || {};
    const cl = ((res.indicators.quote[0] || {}).close || []).filter(v => v != null);
    const price = m.regularMarketPrice ?? cl[cl.length - 1], prev = cl.length >= 2 ? cl[cl.length - 2] : m.chartPreviousClose;
    return { sym, price: r2(price), prev: r2(prev), chg: price && prev ? r2((price - prev) / prev * 100) : null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, cur: m.currency || '', state: m.marketState || '' };
  }
  async function yahooList(key, list, ttl = 5 * 60000) {
    return (await cached(key, ttl, async () => {
      const rows = [];
      const old = (cache.get(key) || {}).data, prevRows = Object.fromEntries(((old && old.rows) || []).filter(r => !r.error).map(r => [r.sym, r]));
      for (const [sym, name] of list) {
        try { rows.push({ ...(await yahooOne(sym)), name }); }
        catch (e) { rows.push(prevRows[sym] ? { ...prevRows[sym], name, stale: true } : { sym, name, error: e.message }); } // 單檔失敗時沿用上次成功的報價
      }
      if (rows.every(r => r.error)) throw new Error('Yahoo Finance 暫時無法取得');
      return { rows };
    })).data;
  }
  const US = [['AAPL', '蘋果'], ['MSFT', '微軟'], ['NVDA', '輝達'], ['GOOGL', 'Alphabet（Google）'], ['AMZN', '亞馬遜'], ['META', 'Meta'], ['TSLA', '特斯拉'], ['AVGO', '博通'], ['AMD', '超微'], ['TSM', '台積電 ADR'],
    ['INTC', '英特爾'], ['QCOM', '高通'], ['MU', '美光'], ['ARM', '安謀'], ['SMCI', '美超微'], ['NFLX', '網飛'], ['ORCL', '甲骨文'], ['PLTR', 'Palantir'], ['BRK-B', '波克夏 B'], ['JPM', '摩根大通']];
  const JP = [['7203.T', '豐田汽車'], ['6758.T', '索尼'], ['8035.T', '東京威力科創'], ['9984.T', '軟銀集團'], ['6857.T', '愛德萬測試'], ['6861.T', '基恩斯'], ['9983.T', '迅銷（UNIQLO）'],
    ['8306.T', '三菱日聯金融'], ['6501.T', '日立'], ['7974.T', '任天堂'], ['4063.T', '信越化學'], ['6146.T', '迪思科'], ['7011.T', '三菱重工'], ['8058.T', '三菱商事'], ['6723.T', '瑞薩電子']];
  const GFUT = [['ES=F', '標普 500 期貨'], ['NQ=F', '那斯達克 100 期貨'], ['YM=F', '道瓊期貨'], ['RTY=F', '羅素 2000 期貨'], ['NKD=F', '日經 225 期貨（美元）'], ['GC=F', '黃金期貨'], ['CL=F', '原油期貨'], ['ZN=F', '美國 10 年公債期貨']];
  const us = () => yahooList('us', US);
  const jp = () => yahooList('jp', JP);
  const gfut = () => yahooList('gfut', GFUT, 3 * 60000);
  async function yahooSearch(sym) {
    const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9.\-=^]/g, '').slice(0, 12); if (!s) throw new Error('代號格式錯誤');
    return (await cached('ys:' + s, 3 * 60000, async () => ({ rows: [{ ...(await yahooOne(s)), name: s }] }))).data;
  }

  return { twRank, etf, twIndices, futures, options, warrants, us, jp, gfut, yahooSearch };
};
