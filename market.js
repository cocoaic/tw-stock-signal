// 全市場資料層：上市普通股的基本面、近 60 日 K 線、技術指標、K 線型態、三大法人分項籌碼。
// 只用證交所公開資料；所有對 www.twse.com.tw 的請求都經過節流（至少間隔 4 秒）。
'use strict';

module.exports = function createMarket(ctx) {
  const { getJSON, toNum, ymd, tpeNow, indicators } = ctx;
  const HIST_DAYS = 65, CHIP_DAYS = 10;
  const isCommon = c => /^[1-9]\d{3}$/.test(c);

  const M = {
    stocks: new Map(),       // code -> stock
    days: [],                // 已載入的交易日（YYYYMMDD，舊到新）
    chipDays: [],
    status: { phase: 'idle', loadedDays: 0, targetDays: HIST_DAYS, chipDays: 0, fundamentals: false, revenue: false, error: null, updated: null }
  };
  const S = code => {
    let s = M.stocks.get(code);
    if (!s) { s = { code, name: '', industry: null, hist: [], chips: [] }; M.stocks.set(code, s); }
    return s;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pick = (obj, ...keys) => { for (const k of Object.keys(obj)) if (keys.some(x => k.includes(x))) return obj[k]; return undefined; };

  // ---------- 證交所表格解析（新舊兩種回應格式都支援）----------
  function findTable(j, mustHave) {
    const tables = [];
    if (Array.isArray(j.tables)) tables.push(...j.tables);
    for (let i = 1; i <= 9; i++) if (j['fields' + i]) tables.push({ fields: j['fields' + i], data: j['data' + i] });
    if (j.fields && j.data) tables.push({ fields: j.fields, data: j.data });
    return tables.find(t => Array.isArray(t.fields) && mustHave.every(m => t.fields.some(f => String(f).includes(m))) && Array.isArray(t.data));
  }
  const col = (fields, name) => fields.findIndex(f => String(f).includes(name));

  async function twse(paths) {
    for (const p of paths) {
      try { return await getJSON(p); } catch (e) { ctx.log('證交所請求失敗', p.split('?')[0], e.message); }
    }
    return null;
  }

  // ---------- 單日全市場行情 ----------
  async function loadDay(date) {
    const j = await twse([
      `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`,
      `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date}&type=ALLBUT0999`
    ]);
    if (!j || (j.stat && j.stat !== 'OK')) return false;
    const t = findTable(j, ['證券代號', '收盤價']);
    if (!t) return false;
    const f = t.fields, iC = col(f, '證券代號'), iN = col(f, '證券名稱'), iV = col(f, '成交股數'), iA = col(f, '成交金額'),
      iO = col(f, '開盤價'), iH = col(f, '最高價'), iL = col(f, '最低價'), iE = col(f, '收盤價');
    let n = 0;
    for (const r of t.data) {
      const code = String(r[iC]).trim(); if (!isCommon(code)) continue;
      const c = toNum(r[iE]); if (c == null) continue; // 當日無成交
      const s = S(code); s.name = String(r[iN]).trim();
      if (s.hist.some(x => x.d === date)) continue;
      s.hist.push({ d: date, o: toNum(r[iO]) ?? c, h: toNum(r[iH]) ?? c, l: toNum(r[iL]) ?? c, c, v: (toNum(r[iV]) || 0) / 1000, a: toNum(r[iA]) || 0 });
      s.hist.sort((a, b) => a.d < b.d ? -1 : 1);
      if (s.hist.length > HIST_DAYS + 5) s.hist.shift();
      n++;
    }
    if (!n) return false;
    if (!M.days.includes(date)) { M.days.push(date); M.days.sort(); }
    return true;
  }

  // ---------- 單日三大法人（外資、投信、自營商分開）----------
  async function loadChips(date) {
    const j = await twse([
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`,
      `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`
    ]);
    if (!j || (j.stat && j.stat !== 'OK')) return false;
    const t = findTable(j, ['證券代號', '投信']);
    if (!t) return false;
    const f = t.fields, iC = col(f, '證券代號');
    const iF = f.findIndex(x => String(x).includes('外陸資買賣超股數') && String(x).includes('不含')) >= 0
      ? f.findIndex(x => String(x).includes('外陸資買賣超股數') && String(x).includes('不含')) : col(f, '外資買賣超');
    const iT = col(f, '投信買賣超'), iD = f.findIndex(x => String(x) === '自營商買賣超股數') >= 0 ? f.findIndex(x => String(x) === '自營商買賣超股數') : col(f, '自營商買賣超'),
      iS = col(f, '三大法人買賣超');
    const lots = v => Math.round((toNum(v) || 0) / 1000);
    for (const r of t.data) {
      const code = String(r[iC]).trim(); if (!isCommon(code)) continue;
      const s = S(code);
      if (s.chips.some(x => x.d === date)) continue;
      s.chips.push({ d: date, f: lots(r[iF]), t: lots(r[iT]), dl: lots(r[iD]), sum: lots(r[iS]) });
      s.chips.sort((a, b) => a.d < b.d ? -1 : 1);
      if (s.chips.length > CHIP_DAYS) s.chips.shift();
    }
    if (!M.chipDays.includes(date)) { M.chipDays.push(date); M.chipDays.sort(); }
    return true;
  }

  // ---------- 本益比、殖利率、股價淨值比 ----------
  async function loadFundamentals() {
    let list = null;
    try { list = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL'); } catch (e) { ctx.log('本益比資料（openapi）失敗', e.message); }
    let n = 0;
    if (Array.isArray(list)) {
      for (const r of list) {
        const code = String(pick(r, 'Code', '代號') || '').trim(); if (!isCommon(code)) continue;
        const s = S(code); s.name = s.name || String(pick(r, 'Name', '名稱') || '').trim();
        s.pe = toNum(pick(r, 'PEratio', '本益比')); s.dy = toNum(pick(r, 'DividendYield', '殖利率')); s.pb = toNum(pick(r, 'PBratio', '淨值比'));
        n++;
      }
    }
    if (!n) {
      const j = await twse([`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&selectType=ALL`, `https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&selectType=ALL`]);
      const t = j && findTable(j, ['證券代號', '本益比']);
      if (t) {
        const f = t.fields, iC = col(f, '證券代號'), iP = col(f, '本益比'), iY = col(f, '殖利率'), iB = col(f, '淨值比');
        for (const r of t.data) { const code = String(r[iC]).trim(); if (!isCommon(code)) continue; const s = S(code); s.pe = toNum(r[iP]); s.dy = toNum(r[iY]); s.pb = toNum(r[iB]); n++; }
      }
    }
    M.status.fundamentals = n > 0;
    return n > 0;
  }

  // ---------- 月營收（含年增率、產業別）----------
  async function loadRevenue() {
    let list = null;
    try { list = await getJSON('https://openapi.twse.com.tw/v1/opendata/t187ap05_L'); } catch (e) { ctx.log('月營收資料失敗', e.message); }
    if (!Array.isArray(list)) return false;
    let n = 0;
    for (const r of list) {
      const code = String(pick(r, '公司代號') || '').trim(); if (!isCommon(code)) continue;
      const s = S(code);
      s.name = s.name || String(pick(r, '公司名稱') || '').trim();
      s.industry = String(pick(r, '產業別') || '').trim() || s.industry;
      s.rev = { ym: String(pick(r, '資料年月') || ''), month: toNum(pick(r, '當月營收')), yoy: toNum(pick(r, '去年同月增減')), mom: toNum(pick(r, '上月比較增減')), cumYoy: toNum(pick(r, '前期比較增減')) };
      n++;
    }
    M.status.revenue = n > 0;
    return n > 0;
  }

  // ---------- 衍生計算：技術指標、K 線型態、籌碼摘要 ----------
  function derive(s) {
    const h = s.hist, n = h.length;
    s.calc = null; if (!n) return;
    const last = h[n - 1], prev = h[n - 2];
    const closes = h.map(x => x.c);
    const ma = (p, off = 0) => n - off >= p ? closes.slice(n - off - p, n - off).reduce((a, b) => a + b, 0) / p : null;
    const avgV = p => n >= p ? h.slice(-p).reduce((a, b) => a + b.v, 0) / p : null;
    const ind = n >= 10 ? indicators(h.map(x => ({ date: x.d, c: x.c, h: x.h, l: x.l }))) : null;
    const ma5 = ma(5), ma20 = ma(20), ma60 = ma(60), pma5 = ma(5, 1), pma20 = ma(20, 1), pma60 = ma(60, 1);
    const v20 = avgV(20);
    const chg = prev ? (last.c - prev.c) / prev.c * 100 : null;
    const ret = p => n > p ? (last.c - h[n - 1 - p].c) / h[n - 1 - p].c * 100 : null;
    const hi20prev = n > 20 ? Math.max(...h.slice(n - 21, n - 1).map(x => x.h)) : null;
    const hi60 = n >= 60 ? Math.max(...h.slice(-60).map(x => x.h)) : null;
    const body = Math.abs(last.c - last.o), upper = last.h - Math.max(last.c, last.o), lower = Math.min(last.c, last.o) - last.l;

    const P = [];
    if (prev && last.c > last.o && (last.c - last.o) / prev.c >= 0.035) P.push('long_red');
    if (prev && last.l > prev.h) P.push('gap_up');
    if (hi20prev && last.c > hi20prev) P.push('new_high20');
    if (hi60 && last.h >= hi60 && n >= 60) P.push('high60');
    if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60 && last.c > ma5) P.push('bull_align');
    if (ma5 && ma20 && ma60 && ma5 < ma20 && ma20 < ma60 && last.c < ma5) P.push('bear_align');
    if (ma5 && ma20 && pma5 && pma20 && pma5 <= pma20 && ma5 > ma20) P.push('ma_golden');
    if (ma5 && ma20 && pma5 && pma20 && pma5 >= pma20 && ma5 < ma20) P.push('ma_dead');
    if (ma20 && pma20 && prev && prev.c <= pma20 && last.c > ma20) P.push('cross_ma20');
    if (ma60 && pma60 && prev && prev.c >= pma60 && last.c < ma60) P.push('break_ma60');
    if (body > 0 && lower >= body * 2 && upper <= body * 0.5 && ma20 && last.c < ma20) P.push('hammer');
    if (v20 && last.v > v20 * 2 && chg > 0) P.push('vol_surge_up');
    if (n >= 4 && h.slice(-3).every((x, i) => x.c > h[n - 4 + i].c)) P.push('up3');
    if (ind && ind.kdCross === 'golden') P.push('kd_golden');
    if (ind && ind.macdCross === 'golden') P.push('macd_golden');

    const C = s.chips || [];
    const streak = key => { let k = 0; for (let i = C.length - 1; i >= 0 && C[i][key] > 0; i--) k++; return k; };
    const sellStreak = key => { let k = 0; for (let i = C.length - 1; i >= 0 && C[i][key] < 0; i--) k++; return k; };
    const sum = (key, p) => C.slice(-p).reduce((a, b) => a + b[key], 0);
    const lc = C[C.length - 1];
    s.calc = {
      date: last.d, price: last.c, prev: prev ? prev.c : null, chg: chg != null ? +chg.toFixed(2) : null,
      ret5: ret(5) != null ? +ret(5).toFixed(2) : null, ret20: ret(20) != null ? +ret(20).toFixed(2) : null,
      vol: Math.round(last.v), vol20: v20 ? Math.round(v20) : null, value: last.a,
      ma5: ma5 && +ma5.toFixed(2), ma20: ma20 && +ma20.toFixed(2), ma60: ma60 && +ma60.toFixed(2),
      rsi: ind && ind.rsi, k: ind && ind.k, d: ind && ind.d, macdHist: ind && ind.hist, kdCross: ind && ind.kdCross, macdCross: ind && ind.macdCross,
      patterns: P,
      chips: lc ? {
        date: lc.d, f: lc.f, t: lc.t, dl: lc.dl, sum: lc.sum,
        f5: sum('f', 5), t5: sum('t', 5), dl5: sum('dl', 5), sum5: sum('sum', 5),
        fDays: streak('f'), tDays: streak('t'), fSellDays: sellStreak('f'), tSellDays: sellStreak('t')
      } : null
    };
  }
  function deriveAll() { for (const s of M.stocks.values()) derive(s); M.status.updated = new Date().toISOString(); }

  // ---------- 載入排程 ----------
  function tradingDatesBack(maxBack) {
    const out = [], t = tpeNow();
    for (let i = 0; i < maxBack; i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
      if (i === 0 && (t.getHours() < 15 || (t.getHours() === 15 && t.getMinutes() < 30))) continue; // 當日資料約 15:00 後公布
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      out.push(ymd(d));
    }
    return out;
  }
  let running = false;
  async function fullLoad() {
    if (running) return; running = true;
    try {
      M.status.phase = 'fundamentals';
      await loadFundamentals(); await loadRevenue(); deriveAll();
      M.status.phase = 'history';
      const tried = new Set(M.days);
      let misses = 0;
      for (const d of tradingDatesBack(140)) {
        if (M.days.length >= HIST_DAYS || misses > 25) break;
        if (tried.has(d)) continue;
        const ok = await loadDay(d);
        if (ok) { M.status.loadedDays = M.days.length; if (M.days.length % 5 === 0 || M.days.length < 3) deriveAll(); } else misses++; // 假日也算一次失敗
        // 先載入最近 10 日法人，讓籌碼早點可用
        if (ok && M.chipDays.length < CHIP_DAYS && !M.chipDays.includes(d)) { if (await loadChips(d)) M.status.chipDays = M.chipDays.length; }
      }
      deriveAll();
      M.status.phase = 'ready'; M.status.error = M.days.length ? null : '歷史行情載入失敗';
    } catch (e) { M.status.error = e.message; ctx.log('全市場載入錯誤', e.message); }
    finally { running = false; }
  }
  // 每天收盤後補當日資料
  async function dailyUpdate() {
    const days = tradingDatesBack(3);
    const d = days[0]; if (!d || M.days.includes(d)) return;
    if (await loadDay(d)) { await loadChips(d); await loadFundamentals(); deriveAll(); M.status.loadedDays = M.days.length; M.status.chipDays = M.chipDays.length; }
  }
  let lastRevDay = null;
  async function loop() {
    try {
      if (M.status.phase === 'idle' || (M.status.phase === 'ready' && M.days.length < 20)) await fullLoad();
      else if (M.status.phase === 'ready') {
        await dailyUpdate();
        const today = ymd(tpeNow());
        if (lastRevDay !== today) { if (await loadRevenue()) lastRevDay = today; }
      }
    } catch (e) { ctx.log('全市場排程錯誤', e.message); }
    setTimeout(loop, 20 * 60000);
  }

  // ---------- 條件選股 ----------
  const PATTERNS = {
    long_red: '長紅K', gap_up: '跳空上漲', new_high20: '突破20日高', high60: '創60日新高', bull_align: '均線多頭排列', bear_align: '均線空頭排列',
    ma_golden: '5/20日線黃金交叉', ma_dead: '5/20日線死亡交叉', cross_ma20: '站上月線', break_ma60: '跌破季線', hammer: '低檔錘子線',
    vol_surge_up: '爆量上漲', up3: '連三漲', kd_golden: 'KD黃金交叉', macd_golden: 'MACD翻多'
  };
  const n = v => (v === '' || v == null ? null : toNum(v));
  function screen(q) {
    const f = {
      peMin: n(q.peMin), peMax: n(q.peMax), dyMin: n(q.dyMin), pbMax: n(q.pbMax), revYoyMin: n(q.revYoyMin), revCumYoyMin: n(q.revCumYoyMin),
      priceMin: n(q.priceMin), priceMax: n(q.priceMax), valueMin: n(q.valueMin), rsiMin: n(q.rsiMin), rsiMax: n(q.rsiMax),
      chgMin: n(q.chgMin), ret20Min: n(q.ret20Min), ret20Max: n(q.ret20Max),
      aboveMa20: q.aboveMa20 === '1', aboveMa60: q.aboveMa60 === '1', macdPos: q.macdPos === '1',
      patterns: String(q.patterns || '').split(',').filter(p => PATTERNS[p]),
      fDaysMin: n(q.fDaysMin), tDaysMin: n(q.tDaysMin), inst5Min: n(q.inst5Min), industry: q.industry || ''
    };
    const out = [];
    for (const s of M.stocks.values()) {
      const c = s.calc; if (!c) continue;
      const ch = c.chips || {};
      if (f.peMin != null && !(s.pe >= f.peMin)) continue;
      if (f.peMax != null && !(s.pe > 0 && s.pe <= f.peMax)) continue;
      if (f.dyMin != null && !(s.dy >= f.dyMin)) continue;
      if (f.pbMax != null && !(s.pb > 0 && s.pb <= f.pbMax)) continue;
      if (f.revYoyMin != null && !(s.rev && s.rev.yoy >= f.revYoyMin)) continue;
      if (f.revCumYoyMin != null && !(s.rev && s.rev.cumYoy >= f.revCumYoyMin)) continue;
      if (f.priceMin != null && !(c.price >= f.priceMin)) continue;
      if (f.priceMax != null && !(c.price <= f.priceMax)) continue;
      if (f.valueMin != null && !(c.value >= f.valueMin * 1e8)) continue;
      if (f.rsiMin != null && !(c.rsi >= f.rsiMin)) continue;
      if (f.rsiMax != null && !(c.rsi != null && c.rsi <= f.rsiMax)) continue;
      if (f.chgMin != null && !(c.chg >= f.chgMin)) continue;
      if (f.ret20Min != null && !(c.ret20 >= f.ret20Min)) continue;
      if (f.ret20Max != null && !(c.ret20 != null && c.ret20 <= f.ret20Max)) continue;
      if (f.aboveMa20 && !(c.ma20 && c.price > c.ma20)) continue;
      if (f.aboveMa60 && !(c.ma60 && c.price > c.ma60)) continue;
      if (f.macdPos && !(c.macdHist > 0)) continue;
      if (f.patterns.length && !f.patterns.every(p => c.patterns.includes(p))) continue;
      if (f.fDaysMin != null && !(ch.fDays >= f.fDaysMin)) continue;
      if (f.tDaysMin != null && !(ch.tDays >= f.tDaysMin)) continue;
      if (f.inst5Min != null && !(ch.sum5 >= f.inst5Min)) continue;
      if (f.industry && s.industry !== f.industry) continue;
      out.push(summary(s));
    }
    const key = q.sort || 'value';
    const val = r => key === 'chg' ? r.chg : key === 'dy' ? r.dy : key === 'revYoy' ? (r.revYoy ?? -1e9) : key === 'tDays' ? r.tDays * 1e6 + (r.t5 || 0) : key === 'fDays' ? r.fDays * 1e6 + (r.f5 || 0) : key === 'pe' ? -(r.pe || 1e9) : key === 'ret20' ? r.ret20 : r.value;
    out.sort((a, b) => (val(b) ?? -1e12) - (val(a) ?? -1e12));
    return { total: out.length, rows: out.slice(0, 60), asOf: M.days[M.days.length - 1] || null, status: M.status };
  }
  function summary(s) {
    const c = s.calc || {}, ch = c.chips || {};
    return {
      code: s.code, name: s.name, industry: s.industry, price: c.price, chg: c.chg, ret20: c.ret20, value: c.value ? +(c.value / 1e8).toFixed(1) : null,
      pe: s.pe, dy: s.dy, pb: s.pb, revYoy: s.rev ? s.rev.yoy : null, rsi: c.rsi, patterns: c.patterns || [],
      f: ch.f, t: ch.t, dl: ch.dl, f5: ch.f5, t5: ch.t5, fDays: ch.fDays || 0, tDays: ch.tDays || 0
    };
  }
  function detail(code) {
    const s = M.stocks.get(code); if (!s) return null;
    return {
      code: s.code, name: s.name, industry: s.industry, pe: s.pe, dy: s.dy, pb: s.pb, rev: s.rev || null, calc: s.calc,
      hist: s.hist.slice(-60).map(x => [x.d, x.o, x.h, x.l, x.c, Math.round(x.v)]), chips: s.chips
    };
  }
  function industries() { return [...new Set([...M.stocks.values()].map(s => s.industry).filter(Boolean))].sort(); }

  return { M, loop, screen, detail, summary, industries, PATTERNS, derive, deriveAll, loadDay, loadChips, loadFundamentals, loadRevenue };
};
