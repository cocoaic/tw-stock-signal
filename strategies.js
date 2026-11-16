// 推薦頁：四種策略篩選（當沖、短線籌碼、長線、存股領息）、類股族群、技術總覽、籌碼總覽。
// 全部用全市場資料（上市普通股）計算；盤中有即時報價的股票（成交最活絡約 180 檔）會改用即時價。
'use strict';

module.exports = function createStrategies(ctx) {
  const { mkt, scan, isMarketTime, tpeNow } = ctx;
  const P = mkt.PATTERNS;
  const r2 = v => v == null || !isFinite(v) ? null : +v.toFixed(2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function elapsedFrac() { const t = tpeNow(), m = t.getHours() * 60 + t.getMinutes() - 540; return clamp(m, 5, 270) / 270; }
  // 每檔的「目前狀態」：盤中用即時，否則用最近收盤
  function view(s) {
    const c = s.calc; if (!c) return null;
    const L = isMarketTime() ? scan.live[s.code] : null;
    const h = s.hist, n = h.length;
    const amp5 = n >= 6 ? h.slice(-5).reduce((a, x, i) => a + (x.h - x.l) / h[n - 6 + i].c, 0) / 5 * 100 : null;
    const price = L && L.price ? L.price : c.price, prev = L && L.prev ? L.prev : c.prev;
    const chg = price && prev ? (price - prev) / prev * 100 : c.chg;
    const volNow = L && L.vol != null ? L.vol : c.vol;
    const volRatio = c.vol20 ? (L ? volNow / elapsedFrac() / c.vol20 : c.vol / c.vol20) : null;
    const pos = L && L.h > L.l ? (price - L.l) / (L.h - L.l) : (n && h[n - 1].h > h[n - 1].l ? (h[n - 1].c - h[n - 1].l) / (h[n - 1].h - h[n - 1].l) : null);
    return { live: !!L, price, prev, chg: r2(chg), volRatio: r2(volRatio), amp5: r2(amp5), pos: r2(pos), value: c.value };
  }
  const base = (s, v) => ({ code: s.code, name: s.name, industry: s.industry, price: v.price, chg: v.chg, live: v.live });

  // ---------- 四種策略 ----------
  const STRATS = {
    daytrade: {
      title: '當沖', desc: '找成交量大、波動夠、今天有量有方向的股票。盤中用即時資料；收盤後列出明天的觀察名單。當沖風險極高，務必設停損。',
      score(s, v) {
        const c = s.calc; if (!v.amp5 || c.value < 5e8 || v.price < 15) return null;
        if (Math.abs(v.chg) >= 9.5) return null; // 鎖漲跌停無法當沖
        const why = []; let sc = 0;
        sc += clamp(v.amp5, 0, 8) * 0.8; why.push(`近 5 日平均振幅 ${v.amp5}%`);
        sc += clamp(c.value / 1e9, 0, 5) * 0.4; why.push(`成交額 ${r2(c.value / 1e8)} 億`);
        if (v.volRatio != null) { sc += clamp(v.volRatio - 1, -1, 3); if (v.volRatio >= 1.5) why.push(`量能放大 ${v.volRatio} 倍`); }
        sc += clamp(Math.abs(v.chg || 0), 0, 6) * 0.3;
        if (v.pos != null && v.chg > 0 && v.pos >= 0.7) { sc += 1; why.push('價格在當日高檔，多方強'); }
        if (v.pos != null && v.chg < 0 && v.pos <= 0.3) { sc += 1; why.push('價格在當日低檔，空方強'); }
        return { sc, why, side: v.chg >= 0 ? '偏多' : '偏空' };
      }
    },
    swing: {
      title: '短線籌碼', desc: '法人連續買超、股價站上月線、短線轉強的股票，持有幾天到幾週。',
      score(s, v) {
        const c = s.calc, ch = c.chips; if (!ch || c.value < 2e8 || !c.ma20 || !c.vol20) return null;
        if (!(v.price > c.ma20)) return null;
        const why = []; let sc = 0;
        const fR = ch.f5 / (c.vol20 * 5), tR = ch.t5 / (c.vol20 * 5);
        if (ch.tDays >= 2) { sc += Math.min(ch.tDays, 6) * 0.8; why.push(`投信連買 ${ch.tDays} 天`); }
        if (ch.fDays >= 2) { sc += Math.min(ch.fDays, 6) * 0.6; why.push(`外資連買 ${ch.fDays} 天`); }
        sc += clamp(tR * 100, -3, 4) + clamp(fR * 50, -3, 3);
        if (ch.sum5 > 0) why.push(`法人 5 日買超 ${ch.sum5.toLocaleString()} 張`);
        if (c.ma5 && c.ma5 > c.ma20) { sc += 0.8; why.push('5 日線在月線之上'); }
        for (const p of ['new_high20', 'kd_golden', 'macd_golden', 'vol_surge_up', 'cross_ma20']) if (c.patterns.includes(p)) { sc += 0.8; why.push(P[p]); }
        if (c.rsi >= 80) { sc -= 2; why.push(`RSI ${c.rsi} 過熱`); }
        if (sc < 2) return null;
        return { sc, why, side: '偏多' };
      }
    },
    long: {
      title: '長線', desc: '營收持續成長、本益比合理、趨勢向上（站上季線），適合放幾個月到幾年的成長股。',
      score(s, v) {
        const c = s.calc, rv = s.rev; if (!rv || rv.yoy == null || rv.cumYoy == null || c.value < 5e7 || !c.ma60) return null;
        if (rv.cumYoy < 10 || rv.yoy < 5) return null;
        if (!(s.pe > 0 && s.pe <= 35)) return null;
        const why = [`今年累計營收年增 ${r2(rv.cumYoy)}%`, `最新月營收年增 ${r2(rv.yoy)}%`, `本益比 ${r2(s.pe)}`];
        let sc = clamp(rv.cumYoy, 0, 60) * 0.08 + clamp(rv.yoy, 0, 80) * 0.04 + (35 - s.pe) * 0.06;
        if (v.price > c.ma60) { sc += 1; why.push('站上季線'); } else sc -= 1.5;
        if (c.ma20 > c.ma60) { sc += 0.6; why.push('月線在季線之上'); }
        if (c.ret20 > 25) { sc -= 1.5; why.push(`近 20 日已漲 ${c.ret20}%，留意追高`); }
        if (s.dy >= 3) { sc += 0.3; why.push(`殖利率 ${r2(s.dy)}%`); }
        return { sc, why, side: '偏多' };
      }
    },
    dividend: {
      title: '存股領息', desc: '殖利率高、本益比與股價淨值比不貴、股價波動小、營收沒有明顯衰退，適合長期領股息。',
      score(s, v) {
        const c = s.calc; if (!(s.dy >= 4) || !(s.pe > 0 && s.pe <= 22) || c.value < 3e7) return null;
        if (s.rev && s.rev.cumYoy != null && s.rev.cumYoy < -15) return null;
        const why = [`殖利率 ${r2(s.dy)}%`, `本益比 ${r2(s.pe)}`]; let sc = clamp(s.dy, 0, 10) * 1.2 + (22 - s.pe) * 0.05;
        if (s.pb != null) { why.push(`股價淨值比 ${r2(s.pb)}`); if (s.pb <= 1.5) sc += 0.6; else if (s.pb > 3) sc -= 0.8; }
        if (v.amp5 != null) { sc += clamp(3 - v.amp5, -2, 2) * 0.5; if (v.amp5 <= 2) why.push(`波動小（振幅 ${v.amp5}%）`); }
        if (c.ma60 && v.price > c.ma60) { sc += 0.5; why.push('站上季線'); }
        if (s.rev && s.rev.cumYoy != null) { sc += clamp(s.rev.cumYoy, -10, 20) * 0.03; if (s.rev.cumYoy >= 0) why.push(`營收年增 ${r2(s.rev.cumYoy)}%`); }
        return { sc, why, side: '偏多' };
      }
    }
  };
  function strategy(type) {
    const st = STRATS[type]; if (!st) return { error: '未知策略' };
    const rows = [];
    for (const s of mkt.M.stocks.values()) {
      const v = view(s); if (!v || !v.price) continue;
      const r = st.score(s, v); if (!r) continue;
      rows.push({ ...base(s, v), score: r2(r.sc), why: r.why, side: r.side, pe: r2(s.pe), dy: r2(s.dy), revYoy: s.rev ? s.rev.yoy : null, amp5: v.amp5, volRatio: v.volRatio,
        f5: s.calc.chips && s.calc.chips.f5, t5: s.calc.chips && s.calc.chips.t5, rsi: s.calc.rsi, ret20: s.calc.ret20 });
    }
    rows.sort((a, b) => b.score - a.score);
    return { type, title: st.title, desc: st.desc, live: isMarketTime(), liveAt: scan.liveAt, asOf: mkt.M.days[mkt.M.days.length - 1] || null, total: rows.length, rows: rows.slice(0, 30), status: mkt.M.status };
  }

  // ---------- 推薦股共用：趨勢＋籌碼＋動能的綜合分數 ----------
  // 歷史還沒載滿 20 日時，用已載入的天數計算報酬
  function retN(s, n) {
    const h = s.hist || [], k = Math.min(n, h.length - 1); if (k < 3) return { v: null, k: 0 };
    const p0 = h[h.length - 1 - k].c, p1 = h[h.length - 1].c; return { v: p0 ? r2((p1 - p0) / p0 * 100) : null, k };
  }
  function pickScore(s, v) {
    const c = s.calc; if (!c || !v || !v.price || c.value < 1e8) return null; // 成交額 1 億以上才推薦，避免冷門股
    if (Math.abs(v.chg || 0) >= 9.5) return null; // 漲跌停買不到／賣不掉
    const why = []; let sc = 0; const ch = c.chips || {};
    if (c.ma20 && v.price > c.ma20) { sc += 1; if (c.ma60 && c.ma20 > c.ma60) { sc += 1; why.push('多頭排列'); } else why.push('站上月線'); } else sc -= 1.5;
    if (ch.f5 > 0 && ch.t5 > 0) { sc += 1.5; why.push('外資投信同步買超'); } else if ((ch.f5 || 0) + (ch.t5 || 0) > 0) { sc += 0.6; why.push('法人 5 日買超'); } else if ((ch.f5 || 0) + (ch.t5 || 0) < 0) sc -= 0.6;
    if (ch.tDays >= 2) { sc += Math.min(ch.tDays, 5) * 0.3; why.push(`投信連買 ${ch.tDays} 天`); }
    if (c.macdHist > 0) sc += 0.4;
    if (c.rsi != null) { if (c.rsi >= 80) { sc -= 1.5; why.push(`RSI ${c.rsi} 過熱`); } else if (c.rsi >= 50) sc += 0.4; }
    for (const p of ['new_high20', 'kd_golden', 'macd_golden', 'vol_surge_up']) if (c.patterns && c.patterns.includes(p)) { sc += 0.5; why.push(P[p]); }
    sc += clamp(v.chg || 0, -3, 5) * 0.15;
    return { sc, why };
  }
  const pickRow = (s, v, r) => ({ ...base(s, v), score: r2(r.sc), why: r.why, industry: s.industry, rsi: s.calc.rsi, ret20: s.calc.ret20 ?? retN(s, 20).v });

  // ---------- 類股族群 ----------
  function sectors() {
    const by = {}; let maxK = 0;
    for (const s of mkt.M.stocks.values()) {
      const c = s.calc; if (!c || !s.industry || !c.value) continue;
      const v = view(s); if (!v) continue;
      const g = by[s.industry] = by[s.industry] || { industry: s.industry, n: 0, up: 0, down: 0, w: 0, chgW: 0, r5W: 0, r5w: 0, r20W: 0, r20w: 0, value: 0, f5: 0, t5: 0, stocks: [] };
      const w = c.value; g.n++; g.w += w; g.value += c.value;
      g.chgW += (v.chg || 0) * w;
      const r5 = c.ret5 ?? retN(s, 5).v, R20 = retN(s, 20), r20 = c.ret20 ?? R20.v; maxK = Math.max(maxK, R20.k);
      if (r5 != null) { g.r5W += r5 * w; g.r5w += w; }
      if (r20 != null) { g.r20W += r20 * w; g.r20w += w; }
      if (v.chg > 0) g.up++; else if (v.chg < 0) g.down++;
      if (c.chips) { g.f5 += c.chips.f5 || 0; g.t5 += c.chips.t5 || 0; }
      const ps = pickScore(s, v);
      g.stocks.push({ code: s.code, name: s.name, chg: v.chg, price: v.price, value: c.value, ret5: r5, ret20: r20, pick: ps ? r2(ps.sc) : null, why: ps ? ps.why : [] });
    }
    const list = Object.values(by).filter(g => g.n >= 3).map(g => ({
      industry: g.industry, n: g.n, up: g.up, down: g.down, chg: r2(g.chgW / g.w), ret5: g.r5w ? r2(g.r5W / g.r5w) : null, ret20: g.r20w ? r2(g.r20W / g.r20w) : null, value: r2(g.value / 1e8), f5: g.f5, t5: g.t5,
      leaders: g.stocks.slice().sort((a, b) => b.value - a.value).slice(0, 8).sort((a, b) => (b.chg || 0) - (a.chg || 0)).slice(0, 4),
      picks: g.stocks.filter(x => x.pick != null && x.pick >= 1.5).sort((a, b) => b.pick - a.pick).slice(0, 3)
    })).sort((a, b) => b.chg - a.chg);
    return { live: isMarketTime(), liveAt: scan.liveAt, asOf: mkt.M.days[mkt.M.days.length - 1] || null, sectors: list, ret20Days: Math.min(20, maxK), status: mkt.M.status };
  }

  // ---------- 技術總覽（市場寬度）----------
  function breadth() {
    let n = 0, up = 0, down = 0, flat = 0, aMa20 = 0, aMa60 = 0, bull = 0, bear = 0, hi = 0, lo = 0, rsiHot = 0, rsiCold = 0, kdG = 0, kdD = 0, macdPos = 0, rsiSum = 0, rsiN = 0, limitUp = 0, limitDown = 0;
    for (const s of mkt.M.stocks.values()) {
      const c = s.calc; if (!c || !c.price) continue;
      const v = view(s); n++;
      if (v.chg > 0) up++; else if (v.chg < 0) down++; else flat++;
      if (v.chg >= 9.5) limitUp++; if (v.chg <= -9.5) limitDown++;
      if (c.ma20 && v.price > c.ma20) aMa20++; if (c.ma60 && v.price > c.ma60) aMa60++;
      if (c.patterns.includes('bull_align')) bull++; if (c.patterns.includes('bear_align')) bear++;
      if (c.patterns.includes('new_high20')) hi++;
      const h = s.hist; if (h.length > 21 && c.price < Math.min(...h.slice(-21, -1).map(x => x.l))) lo++;
      if (c.rsi != null) { rsiSum += c.rsi; rsiN++; if (c.rsi >= 70) rsiHot++; if (c.rsi <= 30) rsiCold++; }
      if (c.kdCross === 'golden') kdG++; if (c.kdCross === 'dead') kdD++;
      if (c.macdHist > 0) macdPos++;
    }
    const pct = x => n ? r2(x / n * 100) : null;
    return { live: isMarketTime(), liveAt: scan.liveAt, asOf: mkt.M.days[mkt.M.days.length - 1] || null, n, up, down, flat, limitUp, limitDown,
      aboveMa20: pct(aMa20), aboveMa60: pct(aMa60), bullAlign: bull, bearAlign: bear, newHigh20: hi, newLow20: lo,
      rsiAvg: rsiN ? r2(rsiSum / rsiN) : null, rsiHot, rsiCold, kdGolden: kdG, kdDead: kdD, macdPos: pct(macdPos), picks: techPicks(), status: mkt.M.status };
  }

  // 技術面推薦：多頭排列或創 20 日新高、MACD 柱為正、RSI 未過熱
  function techPicks(k = 10) {
    const rows = [];
    for (const s of mkt.M.stocks.values()) {
      const c = s.calc; if (!c || !c.patterns) continue; const v = view(s);
      if (!(c.patterns.includes('bull_align') || c.patterns.includes('new_high20'))) continue;
      if (!(c.macdHist > 0) || (c.rsi != null && c.rsi >= 80)) continue;
      const r = pickScore(s, v); if (!r) continue;
      rows.push(pickRow(s, v, r));
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, k);
  }
  // 籌碼面推薦：外資或投信連買、5 日合計買超占均量有意義、股價在月線上
  function chipPicks(k = 10) {
    const rows = [];
    for (const s of mkt.M.stocks.values()) {
      const c = s.calc; if (!c || !c.chips || !c.vol20) continue; const ch = c.chips, v = view(s);
      if (!(ch.fDays >= 2 || ch.tDays >= 2) || !((ch.f5 || 0) + (ch.t5 || 0) > 0)) continue;
      const r = pickScore(s, v); if (!r) continue;
      r.sc += clamp(((ch.f5 || 0) + (ch.t5 || 0)) / (c.vol20 * 5) * 20, 0, 3);
      if (ch.fDays >= 2 && !r.why.some(w => w.includes('外資'))) r.why.unshift(`外資連買 ${ch.fDays} 天`);
      rows.push(pickRow(s, v, r));
    }
    return rows.sort((a, b) => b.score - a.score).slice(0, k);
  }

  // ---------- 籌碼總覽 ----------
  function chipsum() {
    const days = mkt.M.chipDays.slice(-10), tot = Object.fromEntries(days.map(d => [d, { d, f: 0, t: 0, dl: 0 }]));
    const rows = [];
    for (const s of mkt.M.stocks.values()) {
      for (const x of s.chips || []) if (tot[x.d]) { tot[x.d].f += x.f; tot[x.d].t += x.t; tot[x.d].dl += x.dl; }
      const c = s.calc; if (!c || !c.chips) continue;
      rows.push({ code: s.code, name: s.name, industry: s.industry, price: c.price, chg: c.chg, f: c.chips.f, t: c.chips.t, dl: c.chips.dl, sum: c.chips.sum, f5: c.chips.f5, t5: c.chips.t5, fDays: c.chips.fDays, tDays: c.chips.tDays,
        sumAmt: c.chips.sum * c.price / 1e5 }); // 億元（張 × 1000 股 × 價 ÷ 1 億）
    }
    const top = (key, dir, k = 10) => rows.filter(r => r[key] != null && (dir > 0 ? r[key] > 0 : r[key] < 0)).sort((a, b) => dir * (b[key] - a[key])).slice(0, k);
    return { asOf: days[days.length - 1] || null, daily: Object.values(tot),
      foreignBuy: top('f', 1), foreignSell: top('f', -1), trustBuy: top('t', 1), trustSell: top('t', -1), dealerBuy: top('dl', 1), dealerSell: top('dl', -1),
      bigBuy: top('sumAmt', 1), bigSell: top('sumAmt', -1),
      trustStreak: rows.filter(r => r.tDays >= 3).sort((a, b) => b.tDays - a.tDays || b.t5 - a.t5).slice(0, 10),
      foreignStreak: rows.filter(r => r.fDays >= 3).sort((a, b) => b.fDays - a.fDays || b.f5 - a.f5).slice(0, 10), picks: chipPicks(), status: mkt.M.status };
  }
  return { STRATS, strategy, sectors, breadth, chipsum, techPicks, chipPicks };
};
