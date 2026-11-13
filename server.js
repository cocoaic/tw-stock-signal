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

async function getJSON(url) {
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
      return true;
    } catch (e) { console.error('法人抓取失敗', e.message); await sleep(3000); }
  }
  return false;
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
    if (cache.daily[c]) out.daily[c] = cache.daily[c];
    const s = seriesOf(c); if (s) out.series[c] = s;
  }
  return out;
}


// ===== AI 選股：伺服器呼叫 Claude API（需設定環境變數 ANTHROPIC_API_KEY）=====
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const AI_COOLDOWN_MS = 3 * 60000; // 全站共用冷卻時間，避免公開網址被狂按造成費用
const ai = { result: null, at: null, busy: false, error: null };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 50000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function runAI(input) {
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
{"summary":"一兩句整體看法","picks":[{"code":"代號","rank":1,"view":"偏多|觀望|偏空","confidence":1到5,"reason":"40字內理由","watch":"接下來要注意的價位或訊號，30字內"}],"risk":"一句風險提醒"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 回覆格式無法解析');
  return JSON.parse(m[0]);
}

async function handleAI(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const state = () => ({ enabled: !!process.env.ANTHROPIC_API_KEY, model: AI_MODEL, result: ai.result, at: ai.at, busy: ai.busy, error: ai.error,
    nextAllowed: ai.at ? new Date(new Date(ai.at).getTime() + AI_COOLDOWN_MS).toISOString() : null });
  if (req.method === 'GET') return send(200, state());
  if (!process.env.ANTHROPIC_API_KEY) return send(200, Object.assign(state(), { error: '尚未設定 ANTHROPIC_API_KEY' }));
  if (ai.busy) return send(200, state());
  if (ai.at && Date.now() - new Date(ai.at).getTime() < AI_COOLDOWN_MS) return send(200, state());
  let input = {};
  try { input = await readBody(req); } catch (e) { return send(400, { error: '資料格式錯誤' }); }
  ai.busy = true; ai.error = null;
  try { ai.result = await runAI(input); ai.at = new Date().toISOString(); }
  catch (e) { ai.error = 'AI 分析失敗：' + e.message; ai.at = new Date(Date.now() - AI_COOLDOWN_MS + 30000).toISOString(); console.error(ai.error); }
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
  loop(); dailyLoop(); histLoop();
});
