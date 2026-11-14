// 台股訊號分析伺服器：集中向證交所抓報價並快取，手機只讀本伺服器。
// 無外部套件，需要 Node 18+（內建 fetch）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEFAULTS = (process.env.STOCKS || '0050,2330').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CODES = 30;            // 全站同時追蹤上限，控制對證交所的請求量
const REQ_TTL_MS = 20 * 60000;   // 手機加入的股票 20 分鐘沒人看就停止追蹤
const POLL_OPEN_MS = 5000;       // 盤中（平日 9:00–13:30）每 5 秒一次，所有股票合併成一個請求
const CHECK_MS = 30000;          // 非盤中只每 30 秒檢查是否開盤
const UA = 'Mozilla/5.0 (tw-stock-signal personal use)';
const CODE_RE = /^\d{4,6}[A-Z]?$/;

const cache = { quotes: {}, daily: {}, series: {}, updated: null, error: null, source: 'mis.twse.com.tw' };
const requested = new Map(); // code -> 最後一次有手機要求的時間
let instMap = {}, instDate = null;

function tpeNow() {
  const d = new Date();
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
}
function isMarketTime() {
  const t = tpeNow(), day = t.getDay(), m = t.getHours() * 60 + t.getMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 && m <= 13 * 60 + 30;
}
const ymd = t => `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
const toNum = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
const firstPrice = s => (s ? toNum(String(s).split('_')[0]) : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 對 www.twse.com.tw 的請求全站排隊，至少間隔 4 秒，避免被證交所封鎖
const HOST_GAP = { 'www.twse.com.tw': 4000 }, nextAt = {};
async function getJSON(url) {
  const host = new URL(url).host;
  if (HOST_GAP[host]) { const now = Date.now(), at = Math.max(now, nextAt[host] || 0); nextAt[host] = at + HOST_GAP[host]; if (at > now) await sleep(at - now); }
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function activeCodes() {
  const now = Date.now(), set = new Set(DEFAULTS);
  for (const [c, t] of requested) { if (now - t > REQ_TTL_MS) requested.delete(c); else set.add(c); }
  return [...set].slice(0, MAX_CODES);
}
function touch(codes) {
  for (const c of codes) {
    if (!CODE_RE.test(c)) continue;
    if (!requested.has(c) && activeCodes().length >= MAX_CODES) continue;
    const isNew = !requested.has(c) && !DEFAULTS.includes(c);
    requested.set(c, Date.now());
    if (isNew) { needQuote = true; queueHistory(c); }
  }
}

// ===== 即時報價：上市 tse_，查無資料再試上櫃 otc_ =====
const market = {};
let needQuote = false;
async function pollQuotes() {
  const codes = activeCodes();
  try {
    const exch = codes.map(c => `${market[c] || 'tse'}_${c}.tw`).join('|');
    const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exch}&json=1&delay=0&_=${Date.now()}`);
    const seen = new Set(), open = isMarketTime();
    for (const q of j.msgArray || []) {
      const code = q.c; seen.add(code);
      const bid = firstPrice(q.b), ask = firstPrice(q.a);
      let price = toNum(q.z);
      if (price == null) price = bid != null && ask != null ? +((bid + ask) / 2).toFixed(2) : (bid ?? ask);
      cache.quotes[code] = {
        code, name: q.n, market: market[code] || 'tse', price, open: toNum(q.o), high: toNum(q.h), low: toNum(q.l),
        prev: toNum(q.y), vol: toNum(q.v), bid, ask, time: q.t || null, date: q.d || null,
        limitUp: toNum(q.u), limitDown: toNum(q.w)
      };
      // 盤中走勢：每分鐘保留最後一筆價格
      if (open && price != null && q.t) {
        const s = cache.series[code] && cache.series[code].date === q.d ? cache.series[code] : (cache.series[code] = { date: q.d, pts: {} });
        s.pts[q.t.slice(0, 5)] = price;
      }
    }
    for (const c of codes) if (!seen.has(c) && !market[c]) { market[c] = 'otc'; needQuote = true; }
    cache.updated = new Date().toISOString(); cache.error = null;
  } catch (e) {
    cache.error = '報價抓取失敗：' + e.message;
    console.error(cache.error);
  }
}

// ===== 技術指標（用日 K 計算）=====
function ema(arr, n) { const k = 2 / (n + 1); const out = []; arr.forEach((v, i) => out.push(i ? v * k + out[i - 1] * (1 - k) : v)); return out; }
function indicators(rows) {
  const close = rows.map(r => r.c), n = close.length;
  if (n < 10) return null;
  const ma = p => n >= p ? +(close.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(2) : null;
  let rsi = null;
  if (n > 15) {
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const d = close[i] - close[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= 14; l /= 14;
    for (let i = 15; i < n; i++) { const d = close[i] - close[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
    rsi = l === 0 ? 100 : +(100 - 100 / (1 + g / l)).toFixed(1);
  }
  let K = 50, D = 50, pK = 50, pD = 50;
  for (let i = 8; i < n; i++) {
    const win = rows.slice(i - 8, i + 1), hi = Math.max(...win.map(r => r.h)), lo = Math.min(...win.map(r => r.l));
    const rsv = hi === lo ? 50 : (close[i] - lo) / (hi - lo) * 100;
    pK = K; pD = D; K = K * 2 / 3 + rsv / 3; D = D * 2 / 3 + K / 3;
  }
  const e12 = ema(close, 12), e26 = ema(close, 26), dif = close.map((_, i) => e12[i] - e26[i]), sig = ema(dif, 9);
  const hist = dif[n - 1] - sig[n - 1], pHist = dif[n - 2] - sig[n - 2];
  return {
    asOf: rows[n - 1].date, close: close[n - 1], ma5: ma(5), ma20: ma(20), ma60: ma(60), rsi,
    k: +K.toFixed(1), d: +D.toFixed(1), kdCross: pK <= pD && K > D ? 'golden' : pK >= pD && K < D ? 'dead' : null,
    macd: +dif[n - 1].toFixed(2), signal: +sig[n - 1].toFixed(2), hist: +hist.toFixed(2),
    macdCross: pHist <= 0 && hist > 0 ? 'golden' : pHist >= 0 && hist < 0 ? 'dead' : null
  };
}

const mkt = require('./market')({ getJSON, toNum, ymd, tpeNow, indicators, log: (...a) => console.error(...a) });

const pre = require('./premarket')({ getJSON, toNum, ymd, tpeNow, log: (...a) => console.error(...a) });
let preRefreshing = false;
const fin = require('./financials')({ toNum, log: (...a) => console.error(...a) });
const celeb = require('./celeb')({ toNum, log: (...a) => console.error(...a) });
const tr = require('./translate')({ ask: p => askAI(p), enabled: () => !!AI_KEY, log: (...a) => console.error(...a) });
const news = require('./news')({ log: (...a) => console.error(...a) });
const newsAI = { result: null, at: null, busy: false, error: null };

// 日 K：上市用證交所 STOCK_DAY（抓近 4 個月）。上櫃目前不提供技術指標。
const histQueue = []; const histDone = {};
function queueHistory(code) { if (!histQueue.includes(code)) histQueue.push(code); }
async function loadHistory(code) {
  const t = tpeNow(); let raw = [];
  for (let back = 3; back >= 0; back--) {
    const d = new Date(t.getFullYear(), t.getMonth() - back, 1);
    try {
      const j = await getJSON(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ymd(d)}&stockNo=${code}`);
      if (j.stat === 'OK' && Array.isArray(j.data)) raw = raw.concat(j.data);
    } catch (e) { console.error('日K抓取失敗', code, e.message); }
    await sleep(3000);
  }
  const rows = raw.map(r => ({ date: r[0], v: toNum(r[1]) / 1000, o: toNum(r[3]), h: toNum(r[4]), l: toNum(r[5]), c: toNum(r[6]) }))
    .filter(r => r.c != null && r.h != null && r.l != null);
  if (!rows.length) return false;
  const last5 = rows.slice(-5).map(r => r.v);
  cache.daily[code] = Object.assign(cache.daily[code] || {}, {
    avg5: Math.round(last5.reduce((a, b) => a + b, 0) / last5.length),
    ind: indicators(rows),
    closes: rows.slice(-20).map(r => r.c)
  });
  applyInst(code);
  return true;
}
function applyInst(code) {
  if (instMap[code] != null) cache.daily[code] = Object.assign(cache.daily[code] || {}, { inst: instMap[code], instDate });
}
// 三大法人：最近一個有資料的交易日（當天資料約 15:00 後才有），全市場一次抓
async function loadInst() {
  const t = tpeNow();
  for (let back = 0; back < 8; back++) {
    const d = new Date(t.getTime() - back * 86400000);
    if (back === 0 && t.getHours() < 16) continue;
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    try {
      const j = await getJSON(`https://www.twse.com.tw/fund/T86?response=json&date=${ymd(d)}&selectType=ALLBUT0999`);
      if (j.stat !== 'OK' || !Array.isArray(j.data)) { await sleep(3000); continue; }
      const idx = (j.fields || []).findIndex(f => f.includes('三大法人買賣超'));
      const m = {};
      for (const row of j.data) m[String(row[0]).trim()] = Math.round(toNum(row[idx >= 0 ? idx : row.length - 1]) / 1000);
      instMap = m; instDate = ymd(d);
      Object.keys(cache.daily).forEach(applyInst);
      if (scan.universe.length) rankScan();
      return true;
    } catch (e) { console.error('法人抓取失敗', e.message); await sleep(3000); }
  }
  return false;
}

// ===== 全市場掃描：上市普通股（約九百多檔）=====
// 盤後：證交所全市場日成交資料（一個請求）＋三大法人（一個請求）初篩。
// 盤中：成交金額前 150 名＋法人買超前 30 名，分批（每批 50 檔、間隔 3 秒）抓即時報價，每 60 秒一輪。
const SCAN_POOL = 180, SCAN_BATCH = 50, SCAN_EVERY_MS = 60000;
const scan = { universe: [], universeDate: null, live: {}, liveAt: null, top: [], at: null, error: null };
const isCommon = c => /^[1-9]\d{3}$/.test(c); // 排除 ETF（00 開頭）、權證、特別股

async function loadUniverse() {
  let list = [];
  try {
    const j = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    if (Array.isArray(j)) list = j.map(r => ({ code: String(r.Code).trim(), name: String(r.Name).trim(), vol: toNum(r.TradeVolume) / 1000,
      value: toNum(r.TradeValue), o: toNum(r.OpeningPrice), h: toNum(r.HighestPrice), l: toNum(r.LowestPrice), c: toNum(r.ClosingPrice), chg: toNum(r.Change), date: r.Date || null }));
  } catch (e) { console.error('全市場資料（openapi）失敗', e.message); }
  if (!list.length) {
    try {
      const j = await getJSON('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json');
      if (j.stat === 'OK' && Array.isArray(j.data)) list = j.data.map(r => ({ code: String(r[0]).trim(), name: String(r[1]).trim(), vol: toNum(r[2]) / 1000,
        value: toNum(r[3]), o: toNum(r[4]), h: toNum(r[5]), l: toNum(r[6]), c: toNum(r[7]), chg: toNum(String(r[8]).replace(/[^\d.\-]/g, '')), date: j.date || null }));
    } catch (e) { console.error('全市場資料（備援）失敗', e.message); }
  }
  list = list.filter(s => isCommon(s.code) && s.c != null && s.c > 0);
  if (!list.length) { scan.error = '全市場資料抓取失敗'; return false; }
  list.forEach(s => { s.prev = s.chg != null ? +(s.c - s.chg).toFixed(2) : null; });
  scan.universe = list; scan.universeDate = list[0].date; scan.error = null;
  rankScan();
  return true;
}

function poolCodes() {
  const byValue = scan.universe.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 150).map(s => s.code);
  const byInst = scan.universe.filter(s => instMap[s.code] > 0).sort((a, b) => instMap[b.code] - instMap[a.code]).slice(0, 30).map(s => s.code);
  return [...new Set(byValue.concat(byInst))].slice(0, SCAN_POOL);
}

async function scanLive() {
  const codes = poolCodes(); if (!codes.length) return;
  for (let i = 0; i < codes.length; i += SCAN_BATCH) {
    const part = codes.slice(i, i + SCAN_BATCH);
    try {
      const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${part.map(c => `tse_${c}.tw`).join('|')}&json=1&delay=0&_=${Date.now()}`);
      for (const q of j.msgArray || []) {
        const bid = firstPrice(q.b), ask = firstPrice(q.a);
        let price = toNum(q.z); if (price == null) price = bid != null && ask != null ? +((bid + ask) / 2).toFixed(2) : (bid ?? ask);
        scan.live[q.c] = { price, o: toNum(q.o), h: toNum(q.h), l: toNum(q.l), prev: toNum(q.y), vol: toNum(q.v), time: q.t };
      }
    } catch (e) { console.error('掃描報價失敗', e.message); }
    await sleep(3000);
  }
  scan.liveAt = new Date().toISOString();
  rankScan();
}

// 掃描分數：漲跌幅、在當日區間的位置、量能（相對前一日、按時間換算）、法人買超占成交量比例、流動性
function rankScan() {
  const open = isMarketTime(), t = tpeNow(), el = Math.max(5, t.getHours() * 60 + t.getMinutes() - 540);
  const rows = [];
  for (const u of scan.universe) {
    const L = open ? scan.live[u.code] : null;
    if (open && !L) continue;
    const price = L ? L.price : u.c, prev = L ? L.prev : u.prev, h = L ? L.h : u.h, l = L ? L.l : u.l, o = L ? L.o : u.o;
    if (!price || !prev) continue;
    const vol = L ? L.vol : u.vol, baseVol = u.vol || null;
    const chg = (price - prev) / prev * 100;
    if (chg >= 9.5) continue; // 已鎖漲停，追不到
    const pos = h && l && h > l ? (price - l) / (h - l) : 0.5;
    const volRatio = open && baseVol && vol ? (vol / (el / 270)) / baseVol : null; // 盤後只有單日資料，不算量比
    const inst = instMap[u.code] ?? null;
    let sc = 0; const why = [];
    sc += Math.max(-3, Math.min(3, chg * 0.6)); why.push(`漲跌 ${chg.toFixed(2)}%`);
    sc += (pos - 0.5) * 3;
    if (o && price > o) sc += 0.5;
    if (volRatio != null) { if (chg > 0 && volRatio > 1.3) { sc += 1.5; why.push(`量增 ${volRatio.toFixed(1)} 倍`); } else if (chg > 0 && volRatio < 0.6) sc -= 0.5; }
    if (inst != null && baseVol) { const r = inst / baseVol; sc += Math.max(-2, Math.min(2, r * 20)); if (Math.abs(r) > 0.03) why.push(`法人${inst > 0 ? '買' : '賣'}超 ${Math.abs(inst).toLocaleString()} 張`); }
    if ((u.value || 0) < 1e8) sc -= 1; // 成交金額不到 1 億，流動性差
    rows.push({ code: u.code, name: u.name, price, prev, chg: +chg.toFixed(2), pos: +pos.toFixed(2), volRatio: volRatio && +volRatio.toFixed(2),
      inst, value: u.value, score: +sc.toFixed(2), why });
  }
  rows.sort((a, b) => b.score - a.score);
  scan.top = rows.slice(0, 30); scan.at = new Date().toISOString(); scan.count = rows.length; scan.mode = open ? 'live' : 'daily';
}

let lastScan = 0, lastUniverseKey = null;
async function scanLoop() {
  try {
    const t = tpeNow(), key = ymd(t) + (t.getHours() >= 15 ? 'pm' : 'am');
    if (key !== lastUniverseKey) { if (await loadUniverse()) lastUniverseKey = key; }
    if (isMarketTime() && Date.now() - lastScan >= SCAN_EVERY_MS) { lastScan = Date.now(); await scanLive(); }
    else if (!isMarketTime() && scan.mode === 'live') rankScan();
  } catch (e) { console.error('掃描失敗', e.message); }
  setTimeout(scanLoop, 10000);
}

// ===== 排程 =====
let wasOpen = false, hasData = false;
async function loop() {
  const open = isMarketTime();
  if (open || !hasData || wasOpen || needQuote) {
    needQuote = false;
    await pollQuotes();
    if (!cache.error) hasData = true;
  }
  wasOpen = open;
  setTimeout(loop, open ? POLL_OPEN_MS : (needQuote ? 3000 : CHECK_MS));
}
let lastDailyKey = null;
async function dailyLoop() {
  const t = tpeNow(), key = ymd(t) + (t.getHours() >= 16 ? 'pm' : 'am');
  if (key !== lastDailyKey) {
    lastDailyKey = key;
    await loadInst();
    for (const k of Object.keys(histDone)) delete histDone[k];
    activeCodes().forEach(queueHistory);
  }
  setTimeout(dailyLoop, 30 * 60000);
}
async function histLoop() {
  const code = histQueue.shift();
  if (code && !histDone[code]) {
    if (market[code] === 'otc') histDone[code] = true;
    else histDone[code] = await loadHistory(code);
    if (!histDone[code]) setTimeout(() => queueHistory(code), 10 * 60000);
  }
  setTimeout(histLoop, code ? 1000 : 5000);
}

function seriesOf(code) {
  const s = cache.series[code]; if (!s) return null;
  return Object.entries(s.pts).sort((a, b) => a[0] < b[0] ? -1 : 1);
}
function payload(codes) {
  const out = { quotes: {}, daily: {}, series: {} };
  for (const c of codes) {
    if (cache.quotes[c]) out.quotes[c] = cache.quotes[c];
    const ms = mkt.M.stocks.get(c);
    if (cache.daily[c] || ms) out.daily[c] = Object.assign({}, cache.daily[c] || {}, ms ? { chips: ms.calc && ms.calc.chips, patterns: ms.calc && ms.calc.patterns, pe: ms.pe, dy: ms.dy, pb: ms.pb, rev: ms.rev, industry: ms.industry } : {});
    const s = seriesOf(c); if (s) out.series[c] = s;
  }
  return out;
}


// ===== AI 選股：伺服器呼叫 Gemini（GEMINI_API_KEY）或 Claude（ANTHROPIC_API_KEY）=====
// 供應商：有 GEMINI_API_KEY 就用 Gemini，否則用 Claude；可用 AI_PROVIDER=gemini|claude 強制指定
const AI_PROVIDER = process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'claude');
const AI_MODEL = AI_PROVIDER === 'gemini' ? (process.env.GEMINI_MODEL || 'gemini-3.5-flash') : (process.env.AI_MODEL || 'claude-sonnet-5-5');
const AI_KEY = AI_PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
const AI_COOLDOWN_MS = 3 * 60000; // 全站共用冷卻時間，避免公開網址被狂按造成費用
const aiStates = { watch: { result: null, at: null, busy: false, error: null }, market: { result: null, at: null, busy: false, error: null } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 50000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function runAI(input) {
  if (input.mode === 'market') return runMarketAI(input);
  const codes = (Array.isArray(input.codes) ? input.codes : DEFAULTS).filter(c => CODE_RE.test(c)).slice(0, MAX_CODES);
  const rows = codes.map(code => {
    const q = cache.quotes[code] || {}, d = cache.daily[code] || {}, sc = (input.scores || {})[code] || {};
    return { code, name: q.name, prev: q.prev, open: q.open, price: q.price, high: q.high, low: q.low,
      volume_lots: q.vol, avg5_lots: d.avg5, institutional_net_lots: d.inst, institutional_date: d.instDate,
      technical: d.ind || null, user_news: (input.news || {})[code] || 0, rule_score: sc.score, rule_pattern: sc.pattern, quote_time: q.time };
  });
  const t = tpeNow();
  const prompt = `你是台股盤中分析助理。現在台北時間 ${t.toTimeString().slice(0, 5)}，${isMarketTime() ? '盤中' : '非盤中'}。
以下是使用者自選股的即時資料（成交量單位：張；user_news：2 利多、-2 利空、0 無）：
${JSON.stringify(rows)}
使用者手動輸入的盤前大盤數據（費半%、那斯達克%、台積電ADR%、夜盤點數、新台幣升貶角、外資買賣超億）：
${JSON.stringify(input.market || {})}
technical 是日線技術指標（ma5/ma20/ma60 均線、rsi、k/d 與 kdCross 交叉、macd/signal/hist 與 macdCross 交叉，asOf 為資料日期）。
規則分數（rule_score）是網頁用固定公式算出的，可參考但請獨立判斷。

請只根據上面資料，比較這些股票目前的相對強弱並排序，不要編造資料中沒有的新聞或數字。
只輸出 JSON，不要其他文字，格式：
{"summary":"一兩句整體看法","picks":[{"code":"代號","rank":1,"view":"偏多|觀望|偏空","confidence":1到5,"reason":"40字內一句話結論","points":["2～4 點推薦依據，每點 30 字內，必須引用上面資料中的具體數字（例如漲幅、量比、法人張數、均線、RSI）"],"stock_risk":"這檔股票本身的主要風險，30字內","watch":"接下來要注意的價位或訊號，30字內"}],"risk":"一句風險提醒"}`;
  const out = await askAI(prompt);
  const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
  (out.picks || []).forEach(p => { const r = byCode[p.code]; if (r) p.data = { price: r.price, prev: r.prev, chg_pct: r.prev && r.price ? +((r.price - r.prev) / r.prev * 100).toFixed(2) : null,
    vol: r.volume_lots, avg5: r.avg5_lots, inst: r.institutional_net_lots, ma20: r.technical && r.technical.ma20, rsi: r.technical && r.technical.rsi, k: r.technical && r.technical.k, d: r.technical && r.technical.d, macd_hist: r.technical && r.technical.hist, rule_score: r.rule_score }; });
  return out;
}

async function askAI(prompt) {
  let text;
  if (AI_PROVIDER === 'gemini') {
    // 新版 Gemini 預設會先「思考」，可能很慢；先要求低思考量，若模型不支援該參數再改用預設
    const call = async (thinking) => {
      const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: 8192 };
      if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(AI_MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': AI_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
        signal: AbortSignal.timeout(150000)
      });
      return { r, j: await r.json() };
    };
    let { r, j } = await call(true);
    if (r.status === 400 && /thinking/i.test(JSON.stringify(j))) ({ r, j } = await call(false));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    const cand = (j.candidates || [])[0] || {};
    text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text) throw new Error('Gemini 沒有回傳內容（' + (cand.finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || '未知原因') + '）');
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(150000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    text = (j.content || []).map(c => c.text || '').join('');
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 回覆格式無法解析');
  return JSON.parse(m[0]);
}

function extra(code) {
  const s = mkt.M.stocks.get(code); if (!s) return {};
  const c = s.calc || {}, ch = c.chips || {};
  return { pe: s.pe, dividend_yield: s.dy, revenue_yoy_pct: s.rev ? s.rev.yoy : null, industry: s.industry, ret20_pct: c.ret20, ma20: c.ma20, rsi: c.rsi,
    patterns: (c.patterns || []).map(p => mkt.PATTERNS[p]), foreign_5d_lots: ch.f5, trust_5d_lots: ch.t5, foreign_buy_days: ch.fDays, trust_buy_days: ch.tDays };
}

async function runMarketAI(input) {
  if (!scan.top.length) throw new Error('全市場掃描資料還沒準備好，請稍候 1～2 分鐘');
  const rows = scan.top.slice(0, 25).map(r => ({ code: r.code, name: r.name, price: r.price, prev: r.prev, chg_pct: r.chg,
    range_pos: r.pos, vol_ratio: r.volRatio, inst_net_lots: r.inst, value_100m: r.value ? +(r.value / 1e8).toFixed(1) : null, scan_score: r.score, ...extra(r.code) }));
  const t = tpeNow();
  const prompt = `你是台股選股助理。現在台北時間 ${t.toTimeString().slice(0, 5)}，${scan.mode === 'live' ? '盤中（即時資料）' : '盤後（最近一個交易日資料，資料日 ' + scan.universeDate + '）'}。
以下是從上市普通股 ${scan.universe.length} 檔中，用規則初篩出的前 ${rows.length} 檔候選（chg_pct 漲跌幅%；pe 本益比；dividend_yield 殖利率%；revenue_yoy_pct 最新月營收年增率%；ret20_pct 近20日漲跌%；patterns K線型態；foreign/trust_5d_lots 外資/投信近5日買賣超張數；foreign/trust_buy_days 連續買超天數；range_pos 在當日高低區間的位置 0～1；vol_ratio 量能相對前一日倍數，盤中已按時間換算；inst_net_lots 三大法人前一交易日買賣超張數；value_100m 前一日成交金額億元；scan_score 規則分數）：
${JSON.stringify(rows)}
使用者手動輸入的盤前大盤數據（可能為空）：${JSON.stringify(input.market || {})}

請只根據上面資料，挑出最值得關注的 5～8 檔並排序，偏好量價配合、法人支持、流動性足夠的股票，避開過度追高。不要編造資料中沒有的新聞、產業題材或數字。
只輸出 JSON，不要其他文字，格式：
{"summary":"一兩句今日盤勢與選股方向","picks":[{"code":"代號","name":"名稱","rank":1,"view":"偏多|觀望|偏空","confidence":1到5,"reason":"40字內一句話結論","points":["2～4 點推薦依據，每點 30 字內，必須引用上面資料中的具體數字（例如漲幅、量比、法人張數、均線、RSI）"],"stock_risk":"這檔股票本身的主要風險，30字內","watch":"接下來要注意的價位或訊號，30字內"}],"risk":"一句風險提醒"}`;
  const out = await askAI(prompt);
  const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
  (out.picks || []).forEach(p => { const r = byCode[p.code]; if (r) { p.name = p.name || r.name; p.data = { price: r.price, prev: r.prev, chg_pct: r.chg_pct, range_pos: r.range_pos, vol_ratio: r.vol_ratio, inst: r.inst_net_lots, value_100m: r.value_100m, scan_score: r.scan_score }; } else p.unverified = true; });
  return out;
}

// ===== AI 一頁式個股報告 =====
const reports = new Map(); // code -> { at, dataDate, result, error, busy }
let lastReportAt = 0;
async function handleReport(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
  if (!CODE_RE.test(code)) return send(400, { error: '代號格式錯誤' });
  const r = reports.get(code) || {};
  const d = mkt.detail(code);
  if (req.method === 'GET') return send(200, { enabled: !!AI_KEY, provider: AI_PROVIDER, ...r });
  if (!AI_KEY) return send(200, { enabled: false, error: '尚未設定 AI 金鑰' });
  if (!d || !d.calc) return send(200, { ...r, error: '這檔股票的資料還沒載入完成（伺服器啟動後約需 5 分鐘載入全市場歷史資料）' });
  if (r.busy) return send(200, r);
  if (r.result && r.dataDate === d.calc.date) return send(200, { ...r, cached: true });
  if (Date.now() - lastReportAt < 20000) return send(200, { ...r, error: '剛有人產生過報告，請 20 秒後再試' });
  lastReportAt = Date.now();
  const st = { busy: true, at: new Date().toISOString() }; reports.set(code, st);
  try {
    const q = cache.quotes[code];
    const F = await Promise.race([fin.get(code).catch(() => null), sleep(25000).then(() => null)]);
    const financials = F && F.income && F.income.length ? { quarters: F.income.map(x => ({ q: x.q, revenue_100m: x.rev != null ? +(x.rev / 1e8).toFixed(1) : null, gross_margin: x.gm, op_margin: x.om, net_margin: x.nm, eps: x.eps })),
      ttm_eps: F.ttmEps, yoy_latest_quarter: F.yoy, balance: F.balance && { debt_ratio: F.balance.debtRatio, current_ratio: F.balance.currentRatio },
      cashflow_ytd_100m: F.cashflow && { cfo: F.cashflow.cfo != null ? +(F.cashflow.cfo / 1e8).toFixed(1) : null, capex: F.cashflow.capex != null ? +(F.cashflow.capex / 1e8).toFixed(1) : null, fcf: F.cashflow.fcf != null ? +(F.cashflow.fcf / 1e8).toFixed(1) : null },
      month_revenue_yoy: (F.monthRev || []).slice(-6).map(m => ({ ym: m.ym, yoy: m.yoy })), dividends: F.dividends } : null;
    const data = { code, name: d.name, financials, industry: d.industry, pe: d.pe, dividend_yield: d.dy, pb: d.pb, monthly_revenue: d.rev, latest: d.calc,
      patterns: (d.calc.patterns || []).map(p => mkt.PATTERNS[p]), chips_10d: d.chips, closes_60d: d.hist.map(x => x[4]),
      live_quote: q && q.price ? { price: q.price, prev: q.prev, open: q.open, high: q.high, low: q.low, vol: q.vol, time: q.time } : null };
    const prompt = `你是台股研究助理，請根據下面「證交所公開資料」為這檔股票寫一頁式重點報告。
資料說明：pe 本益比、dividend_yield 殖利率%、pb 股價淨值比、monthly_revenue 最新月營收（yoy 年增率%、mom 月增率%、cumYoy 累計年增率%）；financials 為近 8 季財報（營收億元、毛利率/營益率/淨利率%、EPS）、近四季 EPS、資產負債比率、今年累計現金流（億元）、近 6 個月營收年增率、近年股利；latest 為最近交易日技術面（ma5/20/60、rsi、k/d、macdHist、ret5/ret20 為近5/20日漲跌%、vol/vol20 成交量與20日均量，單位張）；chips_10d 為近10個交易日三大法人買賣超張數（f 外資、t 投信、dl 自營商）；closes_60d 為近60日收盤價。
${JSON.stringify(data)}

規則：只能使用上面的數字，不可編造新聞、產業題材、財測、目標價或任何資料中沒有的資訊。資料不足就直接說資料不足。用繁體中文。
只輸出 JSON，不要其他文字，格式：
{"headline":"20字內一句話總結","rating":"偏多|中性|偏空","trend":"趨勢與技術面 2～3 句，引用均線、RSI、KD、MACD 數字","chips":"籌碼面 2 句，說明外資投信自營誰在買賣、連續幾天","fundamentals":"基本面 2～3 句：本益比、殖利率、營收年增，以及財報的毛利率趨勢、EPS 成長、負債比與現金流","positives":["2～3 個利多重點"],"negatives":["2～3 個風險或利空"],"levels":{"support":"支撐價位與依據","resistance":"壓力價位與依據"},"suited_for":"適合的操作類型（例如短線、波段、存股）與理由，30字內"}`;
    st.result = await askAI(prompt); st.dataDate = d.calc.date; st.error = null;
  } catch (e) { st.error = 'AI 報告失敗：' + (e.name === 'TimeoutError' ? '回應超過 150 秒' : e.message); }
  finally { st.busy = false; st.at = new Date().toISOString(); }
  send(200, st);
}

// ===== AI 新聞解讀（只根據標題）=====
async function handleNewsAI(req, res) {
  const send = o => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const st = () => ({ enabled: !!AI_KEY, provider: AI_PROVIDER, ...newsAI, nextAllowed: newsAI.at ? new Date(new Date(newsAI.at).getTime() + 10 * 60000).toISOString() : null });
  if (req.method === 'GET') return send(st());
  if (!AI_KEY) return send({ ...st(), error: '尚未設定 AI 金鑰' });
  if (newsAI.busy || (newsAI.at && Date.now() - new Date(newsAI.at).getTime() < 10 * 60000)) return send(st());
  newsAI.busy = true; newsAI.error = null;
  try {
    const cats = await news.all();
    const lines = cats.map(c => `【${c.title}】\n` + c.items.slice(0, 10).map(i => `- ${i.title}（${i.source}，${new Date(i.time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}）`).join('\n')).join('\n\n');
    const prompt = `你是台股研究助理。以下是最近 3 天的財經新聞「標題」，依類別整理：
${lines}

請只根據這些標題，判斷對台股（尤其波段投資）的影響。不要編造標題中沒有的數字或細節，不確定就說不確定。
提醒原則：股價反映的是未來預期；連續大漲後出現超級利多要小心「利多出盡」；好消息剛出、股價在季線附近剛起步且量溫和放大，才是較好的起漲點。
只輸出 JSON，不要其他文字，格式：
{"overall":"偏多|中性|偏空","headline":"25字內總結","points":[{"cat":"類別名稱","impact":"利多|利空|中性","text":"40字內重點與對台股的影響"}],"sectors":{"positive":["可能受惠族群"],"negative":["可能受壓族群"]},"watch":"接下來要盯的事件或數據，40字內","caution":"一句提醒"}
points 請給 3～6 點。`;
    newsAI.result = await askAI(prompt);
  } catch (e) { newsAI.error = 'AI 解讀失敗：' + (e.name === 'TimeoutError' ? '回應超過 150 秒' : e.message); }
  finally { newsAI.busy = false; newsAI.at = new Date().toISOString(); }
  send(st());
}

async function handleAI(req, res) {
  const mode = new URL(req.url, 'http://x').searchParams.get('mode') === 'market' ? 'market' : 'watch';
  const ai = aiStates[mode];
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const state = () => ({ mode, enabled: !!AI_KEY, provider: AI_PROVIDER, model: AI_MODEL, result: ai.result, at: ai.at, busy: ai.busy, error: ai.error,
    nextAllowed: ai.at ? new Date(new Date(ai.at).getTime() + AI_COOLDOWN_MS).toISOString() : null });
  if (req.method === 'GET') return send(200, state());
  if (!AI_KEY) return send(200, Object.assign(state(), { error: '尚未設定 AI 金鑰（GEMINI_API_KEY 或 ANTHROPIC_API_KEY）' }));
  if (ai.busy) return send(200, state());
  if (ai.at && Date.now() - new Date(ai.at).getTime() < AI_COOLDOWN_MS) return send(200, state());
  let input = {};
  try { input = await readBody(req); } catch (e) { return send(400, { error: '資料格式錯誤' }); }
  ai.busy = true; ai.error = null; input.mode = mode;
  try { ai.result = await runAI(input); ai.at = new Date().toISOString(); }
  catch (e) { ai.error = 'AI 分析失敗：' + (e.name === 'TimeoutError' ? 'AI 回應超過 150 秒，請稍後再試' : e.message); ai.at = new Date(Date.now() - AI_COOLDOWN_MS + 30000).toISOString(); console.error(ai.error); }
  finally { ai.busy = false; }
  send(200, state());
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
http.createServer((req, res) => {
  if (req.url.startsWith('/api/quotes')) {
    const u = new URL(req.url, 'http://x');
    const codes = (u.searchParams.get('codes') || DEFAULTS.join(',')).split(',').map(s => s.trim().toUpperCase()).filter(c => CODE_RE.test(c)).slice(0, MAX_CODES);
    touch(codes);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ stocks: codes, marketOpen: isMarketTime(), updated: cache.updated, error: cache.error, tracking: activeCodes().length, max: MAX_CODES, ...payload(codes) }));
  } else if (req.url.startsWith('/api/scan')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ mode: scan.mode || null, at: scan.at, liveAt: scan.liveAt, universe: scan.universe.length, universeDate: scan.universeDate, count: scan.count || 0, error: scan.error, top: scan.top }));
  } else if (req.url.startsWith('/api/celeb/')) {
    const u = new URL(req.url, 'http://x'), kind = u.pathname.split('/')[3];
    const out = v => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ at: v && v.at ? new Date(v.at).toISOString() : null, error: v && v.error, ...(v && v.data || {}) })); };
    const withTimeout = p => Promise.race([p, sleep(25000)]).catch(() => {});
    const coName = s => String(s || '').replace(/^[A-Z.\-]+\s+-\s+/, '').trim();
    const cleanName = s => String(s || '').replace(/^Hon\.\s*/, '').trim();
    // 英文資料加上中文欄位
    const send = async v => {
      const d = v && v.data;
      if (d && Array.isArray(d.items) && (kind === 'us' || kind === 'house' || kind === '13f')) {
        if (kind === 'us') await withTimeout(tr.fill(d.items.map(x => x.company).filter(Boolean), d.items.map(x => x.insider)));
        if (kind === 'house') await withTimeout(tr.fill([], d.items.map(x => cleanName(x.name))));
        if (kind === '13f') await withTimeout(tr.fill(d.items.map(x => coName(x.stock))));
        v = { ...v, data: { ...d, items: d.items.map(x => kind === 'us' ? { ...x, companyZh: tr.company(x.company), insiderZh: tr.person(x.insider), titleZh: tr.title(x.title), typeZh: tr.ttype(x.type) }
          : kind === 'house' ? { ...x, nameEn: cleanName(x.name), nameZh: tr.person(cleanName(x.name)), districtZh: tr.district(x.state) }
          : { ...x, ticker: (String(x.stock).match(/^([A-Z.\-]+)\s+-/) || [])[1] || '', companyEn: coName(x.stock), companyZh: tr.company(coName(x.stock)),
              activityZh: String(x.activity || '').replace(/^Add/i, '加碼').replace(/^Reduce/i, '減碼').replace(/^Buy/i, '新買進').replace(/^Sell/i, '出清') }) } };
      }
      out(v);
    };
    const fail = e => out({ error: e.message });
    if (kind === 'tw') celeb.twInsiders().then(v => {
      const code = (u.searchParams.get('code') || '').trim();
      if (code && v.data) v = { ...v, data: { ...v.data, items: v.data.items.filter(x => x.code === code) } };
      send(v);
    }, fail);
    else if (kind === 'us') celeb.usInsiders(u.searchParams.get('ticker')).then(send, fail);
    else if (kind === 'house') celeb.houseFilings().then(v => {
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      if (v.data) v = { ...v, data: { items: (q ? v.data.items.filter(x => x.name.toLowerCase().includes(q)) : v.data.items).slice(0, 60), total: v.data.items.length } };
      send(v);
    }, fail);
    else if (kind === '13f') celeb.holdings13f(u.searchParams.get('m')).then(send, fail);
    else if (kind === 'monthly' || kind === 'buyback' || kind === 'pledge') celeb.twData(kind).then(v => {
      const code = (u.searchParams.get('code') || '').trim();
      if (code && v.data) v = { ...v, data: { ...v.data, items: v.data.items.filter(x => x.code === code) } };
      out(v);
    }, fail);
    else if (kind === 'holders') { const code = (u.searchParams.get('code') || '').trim(); if (!CODE_RE.test(code)) fail(new Error('代號格式錯誤')); else celeb.holders(code).then(out, fail); }
    else if (kind === 'president') news.search('president', '川普 (股票交易 OR 持股 OR 財務揭露 OR 278-T OR 278e)', 8).then(v => out({ at: Date.parse(v.at), error: v.error, data: { items: v.items } }), fail);
    else send({ error: '未知類別' });
  } else if (req.url.startsWith('/api/fin')) {
    const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!CODE_RE.test(code)) return send(400, { error: '代號格式錯誤' });
    fin.get(code).then(v => send(200, v), e => send(200, { code, error: e.message, income: [] }));
  } else if (req.url.startsWith('/api/news/stock')) {
    const u = new URL(req.url, 'http://x'), code = (u.searchParams.get('code') || '').trim(), name = (u.searchParams.get('name') || '').trim().slice(0, 20);
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!CODE_RE.test(code)) return send({ items: [], error: '代號格式錯誤' });
    news.forStock(name || code, code).then(send, e => send({ items: [], error: e.message }));
  } else if (req.url.startsWith('/api/news/ai')) {
    handleNewsAI(req, res);
  } else if (req.url.startsWith('/api/news')) {
    news.all().then(cats => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ cats, ai: { at: newsAI.at, busy: newsAI.busy } })); });
  } else if (req.url.startsWith('/api/premarket')) {
    const refresh = new URL(req.url, 'http://x').searchParams.get('refresh') === '1';
    const go = () => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(pre.P)); };
    if (refresh && !preRefreshing && (!pre.P.fetchedAt || Date.now() - new Date(pre.P.fetchedAt).getTime() > 120000)) {
      preRefreshing = true; pre.loadAll().finally(() => { preRefreshing = false; go(); });
    } else go();
  } else if (req.url.startsWith('/api/screen')) {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(mkt.screen(q)));
  } else if (req.url.startsWith('/api/meta')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: mkt.M.status, industries: mkt.industries(), patterns: mkt.PATTERNS, asOf: mkt.M.days[mkt.M.days.length - 1] || null, stocks: mkt.M.stocks.size }));
  } else if (req.url.startsWith('/api/stock')) {
    const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
    const d = CODE_RE.test(code) ? mkt.detail(code) : null;
    res.writeHead(d ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(d ? { ...d, quote: cache.quotes[code] || null, status: mkt.M.status } : { error: '查無資料或尚未載入', status: mkt.M.status }));
  } else if (req.url.startsWith('/api/report')) {
    handleReport(req, res);
  } else if (req.url.startsWith('/api/ai')) {
    handleAI(req, res);
  } else if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(INDEX);
  }
}).listen(PORT, () => {
  console.log(`listening on ${PORT}, defaults: ${DEFAULTS.join(',')}`);
  loop(); dailyLoop(); histLoop(); setTimeout(scanLoop, 5000); setTimeout(mkt.loop, 15000); setTimeout(pre.loop, 3000);
});
