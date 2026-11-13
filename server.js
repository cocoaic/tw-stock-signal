// 台股訊號分析伺服器：集中向證交所抓報價並快取，手機只讀本伺服器。
// 無外部套件，需要 Node 18+（內建 fetch）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STOCKS = (process.env.STOCKS || '0050,2330').split(',').map(s => s.trim()).filter(Boolean);
const POLL_OPEN_MS = 5000;     // 盤中每 5 秒一次（所有股票合併成一個請求）
const POLL_CLOSED_MS = 600000; // 非盤中每 10 分鐘一次
const UA = 'Mozilla/5.0 (tw-stock-signal personal use)';

const cache = { quotes: {}, daily: {}, updated: null, error: null, source: 'mis.twse.com.tw' };

function tpeNow() {
  const d = new Date();
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
}
function isMarketTime() {
  const t = tpeNow(), day = t.getDay(), m = t.getHours() * 60 + t.getMinutes();
  return day >= 1 && day <= 5 && m >= 8 * 60 + 30 && m <= 13 * 60 + 35;
}
const ymd = t => `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
const toNum = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
const firstPrice = s => (s ? toNum(String(s).split('_')[0]) : null);

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// 即時報價：上市用 tse_，若查無資料再試上櫃 otc_
const market = {}; // code -> 'tse' | 'otc'
async function pollQuotes() {
  try {
    const exch = STOCKS.map(c => `${market[c] || 'tse'}_${c}.tw`).join('|');
    const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exch}&json=1&delay=0&_=${Date.now()}`);
    const seen = new Set();
    for (const q of j.msgArray || []) {
      const code = q.c; seen.add(code);
      const bid = firstPrice(q.b), ask = firstPrice(q.a);
      let price = toNum(q.z);
      if (price == null) price = bid != null && ask != null ? +((bid + ask) / 2).toFixed(2) : (bid ?? ask);
      cache.quotes[code] = {
        code, name: q.n, price, open: toNum(q.o), high: toNum(q.h), low: toNum(q.l),
        prev: toNum(q.y), vol: toNum(q.v), bid, ask, time: q.t || null, date: q.d || null,
        limitUp: toNum(q.u), limitDown: toNum(q.w)
      };
    }
    for (const c of STOCKS) if (!seen.has(c) && !market[c]) market[c] = 'otc';
    cache.updated = new Date().toISOString(); cache.error = null;
  } catch (e) {
    cache.error = '報價抓取失敗：' + e.message;
    console.error(cache.error);
  }
}

// 每日資料：5 日均量（張）與三大法人前一日買賣超（張），一天抓一次
async function loadDaily() {
  const t = tpeNow();
  for (const code of STOCKS) {
    try {
      let rows = [];
      for (let back = 0; back < 2 && rows.length < 5; back++) {
        const d = new Date(t.getFullYear(), t.getMonth() - back, 1);
        const j = await getJSON(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ymd(d)}&stockNo=${code}`);
        if (j.stat === 'OK' && Array.isArray(j.data)) rows = j.data.concat(rows);
        await sleep(3000);
      }
      const last5 = rows.slice(-5).map(r => toNum(r[1]) / 1000).filter(v => v != null);
      cache.daily[code] = Object.assign(cache.daily[code] || {}, {
        avg5: last5.length ? Math.round(last5.reduce((a, b) => a + b, 0) / last5.length) : null
      });
    } catch (e) { console.error('均量抓取失敗', code, e.message); }
  }
  // 三大法人：從今天往前找最近一個有資料的交易日（今天的資料約 15:00 後才有）
  for (let back = 0; back < 8; back++) {
    const d = new Date(t.getTime() - back * 86400000);
    if (back === 0 && t.getHours() < 16) continue;
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    try {
      const j = await getJSON(`https://www.twse.com.tw/fund/T86?response=json&date=${ymd(d)}&selectType=ALLBUT0999`);
      if (j.stat !== 'OK' || !Array.isArray(j.data)) { await sleep(3000); continue; }
      const fields = j.fields || [];
      const idx = fields.findIndex(f => f.includes('三大法人買賣超'));
      for (const row of j.data) {
        const code = String(row[0]).trim();
        if (STOCKS.includes(code)) {
          cache.daily[code] = Object.assign(cache.daily[code] || {}, {
            inst: Math.round(toNum(row[idx >= 0 ? idx : row.length - 1]) / 1000), instDate: ymd(d)
          });
        }
      }
      break;
    } catch (e) { console.error('法人抓取失敗', e.message); await sleep(3000); }
  }
  cache.dailyLoaded = new Date().toISOString();
  return STOCKS.some(c => cache.daily[c] && cache.daily[c].avg5 != null);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loop() {
  await pollQuotes();
  setTimeout(loop, isMarketTime() ? POLL_OPEN_MS : POLL_CLOSED_MS);
}
let lastDailyDay = null;
async function dailyLoop() {
  const t = tpeNow(), key = ymd(t) + (t.getHours() >= 16 ? 'pm' : 'am');
  let wait = 30 * 60000;
  if (key !== lastDailyDay) { if (await loadDaily()) lastDailyDay = key; else wait = 5 * 60000; }
  setTimeout(dailyLoop, wait);
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
http.createServer((req, res) => {
  if (req.url.startsWith('/api/quotes')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ stocks: STOCKS, marketOpen: isMarketTime(), ...cache }));
  } else if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(INDEX);
  }
}).listen(PORT, () => {
  console.log(`listening on ${PORT}, stocks: ${STOCKS.join(',')}`);
  loop(); dailyLoop();
});
