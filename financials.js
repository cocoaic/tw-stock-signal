// 公司財報：主要來源 FinMind 開放資料（季度損益、資產負債、現金流量、月營收、股利，含歷史），
// 失敗時改用證交所 OpenAPI 的最新一季財報彙總表。每檔快取 12 小時。
'use strict';

module.exports = function createFinancials(ctx) {
  const { toNum, log } = ctx;
  const TTL = 12 * 3600e3;
  const cache = new Map(), inflight = new Map();
  const iso = d => d.toISOString().slice(0, 10);
  const ago = (y, m = 0) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); d.setMonth(d.getMonth() - m); return iso(d); };

  async function finmind(dataset, code, start) {
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${code}&start_date=${start}`;
    const headers = { Accept: 'application/json', 'User-Agent': 'tw-stock-signal' };
    if (process.env.FINMIND_TOKEN) headers.Authorization = 'Bearer ' + process.env.FINMIND_TOKEN;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.status && j.status !== 200)) throw new Error(j.msg || ('HTTP ' + r.status));
    return Array.isArray(j.data) ? j.data : [];
  }
  const pickType = (rows, ...names) => { for (const n of names) { const r = rows.find(x => x.type === n); if (r && r.value != null) return +r.value; } return null; };
  const qLabel = d => { const [y, m] = d.split('-').map(Number); return `${y}Q${Math.ceil(m / 3)}`; };

  function income(rows) {
    const by = {};
    rows.forEach(r => { (by[r.date] = by[r.date] || []).push(r); });
    const qs = Object.keys(by).sort().map(date => {
      const x = by[date];
      const rev = pickType(x, 'Revenue', 'OperatingRevenue', 'TotalOperatingRevenue');
      const gp = pickType(x, 'GrossProfit', 'GrossProfitLossFromOperations');
      const op = pickType(x, 'OperatingIncome', 'NetOperatingIncomeLoss');
      const ni = pickType(x, 'IncomeAfterTaxes', 'TotalConsolidatedProfitForThePeriod', 'NetIncome', 'ProfitLoss', 'EquityAttributableToOwnersOfParent');
      const eps = pickType(x, 'EPS', 'BasicEarningsPerShare');
      return { q: qLabel(date), date, rev, gp, op, ni, eps,
        gm: rev && gp != null ? +(gp / rev * 100).toFixed(2) : null, om: rev && op != null ? +(op / rev * 100).toFixed(2) : null, nm: rev && ni != null ? +(ni / rev * 100).toFixed(2) : null };
    }).filter(q => q.rev != null || q.eps != null);
    return qs.slice(-8);
  }
  function balance(rows) {
    const dates = [...new Set(rows.map(r => r.date))].sort();
    const d = dates[dates.length - 1]; if (!d) return null;
    const x = rows.filter(r => r.date === d);
    const ta = pickType(x, 'TotalAssets'), tl = pickType(x, 'Liabilities', 'TotalLiabilities'), eq = pickType(x, 'Equity', 'TotalEquity', 'EquityAttributableToOwnersOfParent');
    const ca = pickType(x, 'CurrentAssets'), cl = pickType(x, 'CurrentLiabilities'), cash = pickType(x, 'CashAndCashEquivalents');
    return { q: qLabel(d), date: d, totalAssets: ta, totalLiab: tl, equity: eq, currentAssets: ca, currentLiab: cl, cash,
      debtRatio: ta && tl != null ? +(tl / ta * 100).toFixed(1) : null, currentRatio: ca && cl ? +(ca / cl * 100).toFixed(0) : null };
  }
  function cashflow(rows) {
    const dates = [...new Set(rows.map(r => r.date))].sort();
    const d = dates[dates.length - 1]; if (!d) return null;
    const x = rows.filter(r => r.date === d);
    const cfo = pickType(x, 'CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities', 'CashProvidedByOperatingActivities');
    let capex = pickType(x, 'PropertyAndPlantAndEquipment', 'AcquisitionOfPropertyPlantAndEquipment', 'PurchaseOfPropertyPlantAndEquipment');
    if (capex != null && capex > 0) capex = -capex;
    return { q: qLabel(d), date: d, cfo, capex, fcf: cfo != null && capex != null ? cfo + capex : null, ytd: true };
  }
  function monthRevenue(rows) {
    const list = rows.map(r => ({ ym: `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`, rev: +r.revenue })).filter(r => r.rev > 0)
      .sort((a, b) => a.ym < b.ym ? -1 : 1);
    const map = Object.fromEntries(list.map(r => [r.ym, r.rev]));
    list.forEach(r => { const [y, m] = r.ym.split('-'); const p = map[`${+y - 1}-${m}`]; r.yoy = p ? +((r.rev - p) / p * 100).toFixed(1) : null; });
    return list.slice(-13);
  }
  function dividends(rows) {
    const by = {};
    rows.forEach(r => {
      const y = String(r.year || r.date || '').replace(/年.*/, '');
      const cash = (+r.CashEarningsDistribution || 0) + (+r.CashStatutorySurplus || 0);
      const stock = (+r.StockEarningsDistribution || 0) + (+r.StockStatutorySurplus || 0);
      const k = y || r.date; if (!k) return;
      const o = by[k] = by[k] || { year: k, cash: 0, stock: 0, exDate: null };
      o.cash += cash; o.stock += stock; o.exDate = r.CashExDividendTradingDate || o.exDate;
    });
    return Object.values(by).filter(d => d.cash || d.stock).sort((a, b) => String(a.year) < String(b.year) ? 1 : -1).slice(0, 5)
      .map(d => ({ ...d, cash: +d.cash.toFixed(2), stock: +d.stock.toFixed(2) }));
  }

  // ---------- 備援：證交所 OpenAPI 最新一季彙總 ----------
  let twseAll = null, twseAt = 0;
  async function twseLatest(code) {
    if (!twseAll || Date.now() - twseAt > TTL) {
      const get = async p => { try { const r = await fetch('https://openapi.twse.com.tw/v1/opendata/' + p, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); return r.ok ? await r.json() : []; } catch (e) { return []; } };
      twseAll = { inc: await get('t187ap06_L_ci'), bal: await get('t187ap07_L_ci') }; twseAt = Date.now();
    }
    const key = r => String(Object.entries(r).find(([k]) => k.includes('公司代號'))?.[1] || '').trim();
    const v = (r, ...ks) => { for (const [k, val] of Object.entries(r)) if (ks.some(x => k.includes(x))) { const n = toNum(val); if (n != null) return n; } return null; };
    const i = (twseAll.inc || []).find(r => key(r) === code), b = (twseAll.bal || []).find(r => key(r) === code);
    if (!i && !b) return null;
    const out = { fallback: true };
    if (i) {
      const y = v(i, '年度'), s = v(i, '季別');
      const rev = v(i, '營業收入'), gp = v(i, '營業毛利'), op = v(i, '營業利益'), ni = v(i, '本期淨利', '本期綜合損益'), eps = v(i, '基本每股盈餘');
      out.income = [{ q: y && s ? `${y + 1911}Q${s}（今年累計）` : '最新一季', rev: rev && rev * 1000, gp: gp && gp * 1000, op: op && op * 1000, ni: ni && ni * 1000, eps,
        gm: rev && gp != null ? +(gp / rev * 100).toFixed(2) : null, om: rev && op != null ? +(op / rev * 100).toFixed(2) : null, nm: rev && ni != null ? +(ni / rev * 100).toFixed(2) : null }];
    }
    if (b) {
      const ta = v(b, '資產總額', '資產總計'), tl = v(b, '負債總額', '負債總計'), eq = v(b, '權益總額', '權益總計'), ca = v(b, '流動資產'), cl = v(b, '流動負債');
      out.balance = { q: '最新一季', totalAssets: ta && ta * 1000, totalLiab: tl && tl * 1000, equity: eq && eq * 1000,
        debtRatio: ta && tl != null ? +(tl / ta * 100).toFixed(1) : null, currentRatio: ca && cl ? +(ca / cl * 100).toFixed(0) : null };
    }
    return out;
  }

  async function build(code) {
    const out = { code, source: 'FinMind 開放資料（公開資訊觀測站財報）', errors: [] };
    const step = async (name, fn) => { try { return await fn(); } catch (e) { out.errors.push(name + '：' + e.message); return null; } };
    const inc = await step('損益表', () => finmind('TaiwanStockFinancialStatements', code, ago(2, 6)));
    out.income = inc ? income(inc) : [];
    const bal = await step('資產負債表', () => finmind('TaiwanStockBalanceSheet', code, ago(1)));
    out.balance = bal ? balance(bal) : null;
    const cf = await step('現金流量表', () => finmind('TaiwanStockCashFlowsStatement', code, ago(1)));
    out.cashflow = cf ? cashflow(cf) : null;
    const mr = await step('月營收', () => finmind('TaiwanStockMonthRevenue', code, ago(2, 2)));
    out.monthRev = mr ? monthRevenue(mr) : [];
    const dv = await step('股利', () => finmind('TaiwanStockDividend', code, ago(6)));
    out.dividends = dv ? dividends(dv) : [];
    if (!out.income.length) {
      const t = await twseLatest(code).catch(() => null);
      if (t) { out.income = t.income || []; out.balance = out.balance || t.balance || null; out.source = '證交所 OpenAPI 最新一季彙總（FinMind 暫時無法取得）'; }
    }
    const e4 = out.income.slice(-4).map(q => q.eps).filter(v => v != null);
    out.ttmEps = e4.length === 4 && !out.income[0].fallback ? +e4.reduce((a, b) => a + b, 0).toFixed(2) : null;
    const last = out.income[out.income.length - 1], yago = out.income.length >= 5 ? out.income[out.income.length - 5] : null;
    out.yoy = last && yago ? { eps: last.eps != null && yago.eps ? +((last.eps - yago.eps) / Math.abs(yago.eps) * 100).toFixed(1) : null, gm: last.gm != null && yago.gm != null ? +(last.gm - yago.gm).toFixed(2) : null,
      rev: last.rev && yago.rev ? +((last.rev - yago.rev) / yago.rev * 100).toFixed(1) : null } : null;
    out.at = new Date().toISOString();
    if (out.errors.length) log('財報部分失敗', code, out.errors.join('；'));
    return out;
  }
  async function get(code) {
    const c = cache.get(code);
    if (c && Date.now() - new Date(c.at).getTime() < (c.income.length ? TTL : 10 * 60000)) return c;
    if (inflight.has(code)) return inflight.get(code);
    const p = build(code).then(v => { cache.set(code, v); return v; }).finally(() => inflight.delete(code));
    inflight.set(code, p);
    return p;
  }
  function cached(code) { return cache.get(code) || null; }
  return { get, cached };
};
