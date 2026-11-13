// 台股訊號分析伺服器：集中向證交所抓報價並快取，手機只讀本伺服器。
// 無外部套件，需要 Node 18+（內建 fetch）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STOCKS = (process.env.STOCKS || '0050,2330').split(',').map(s => s.trim()).filter(Boolean);
const POLL_OPEN_MS = 5000;     // 盤中（平日 9:00–13:30）每 5 秒一次，所有股票合併成一個請求
const CHECK_MS = 30000;        // 非盤中只每 30 秒檢查是否開盤，不抓報價
const UA = 'Mozilla/5.0 (tw-stock-signal personal use)';

const cache = { quotes: {}, daily: {}, updated: null, error: null, source: 'mis.twse.com.tw' };

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

// 只在盤中抓報價；非盤中保留最後一筆資料不再請求。
// 例外：伺服器剛啟動還沒有資料時抓一次、收盤後補抓一次收盤價。
let wasOpen = false, hasData = false;
async function loop() {
  const open = isMarketTime();
  if (open || !hasData || wasOpen) {
    await pollQuotes();
    if (!cache.error) hasData = true;
  }
  wasOpen = open;
  setTimeout(loop, open ? POLL_OPEN_MS : CHECK_MS);
}
let lastDailyDay = null;
async function dailyLoop() {
  const t = tpeNow(), key = ymd(t) + (t.getHours() >= 16 ? 'pm' : 'am');
  let wait = 30 * 60000;
  if (key !== lastDailyDay) { if (await loadDaily()) lastDailyDay = key; else wait = 5 * 60000; }
  setTimeout(dailyLoop, wait);
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
  const rows = STOCKS.map(code => {
    const q = cache.quotes[code] || {}, d = cache.daily[code] || {}, sc = (input.scores || {})[code] || {};
    return { code, name: q.name, prev: q.prev, open: q.open, price: q.price, high: q.high, low: q.low,
      volume_lots: q.vol, avg5_lots: d.avg5, institutional_net_lots: d.inst, institutional_date: d.instDate,
      user_news: (input.news || {})[code] || 0, rule_score: sc.score, rule_pattern: sc.pattern, quote_time: q.time };
  });
  const t = tpeNow();
  const prompt = `你是台股盤中分析助理。現在台北時間 ${t.toTimeString().slice(0, 5)}，${isMarketTime() ? '盤中' : '非盤中'}。
以下是使用者自選股的即時資料（成交量單位：張；user_news：2 利多、-2 利空、0 無）：
${JSON.stringify(rows)}
使用者手動輸入的盤前大盤數據（費半%、那斯達克%、台積電ADR%、夜盤點數、新台幣升貶角、外資買賣超億）：
${JSON.stringify(input.market || {})}
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ stocks: STOCKS, marketOpen: isMarketTime(), ...cache }));
  } else if (req.url.startsWith('/api/ai')) {
    handleAI(req, res);
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
