// 盤前大盤數據自動抓取：費半、那斯達克、台積電 ADR、新台幣匯率（Yahoo Finance），
// 台指期夜盤（期交所行情系統），外資買賣超金額（證交所 BFI82U）。
// 每項都記錄「資料本身的時間」與「伺服器抓取時間」，前端照實顯示。
'use strict';

module.exports = function createPremarket(ctx) {
  const { getJSON, toNum, ymd, tpeNow, log } = ctx;
  const UA = 'Mozilla/5.0 (tw-stock-signal personal use)';
  const P = { items: {}, fetchedAt: null };
  const set = (k, v) => { P.items[k] = Object.assign({ key: k, fetchedAt: new Date().toISOString() }, v); };
  const fail = (k, source, msg) => { const old = P.items[k]; P.items[k] = Object.assign({}, old || {}, { key: k, source, error: msg, failedAt: new Date().toISOString() }); };

  async function yahoo(sym) {
    const urls = [`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`,
                  `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`];
    let lastErr;
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res) throw new Error('無資料');
        const ts = res.timestamp || [], cl = (res.indicators.quote[0] || {}).close || [];
        const pts = ts.map((t, i) => [t, cl[i]]).filter(x => x[1] != null);
        if (pts.length < 2) throw new Error('資料不足');
        const last = pts[pts.length - 1], prev = pts[pts.length - 2];
        const meta = res.meta || {};
        const price = meta.regularMarketPrice ?? last[1];
        return { price, prev: prev[1], time: (meta.regularMarketTime || last[0]) * 1000, state: meta.marketState || null };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function loadUS() {
    const list = [['sox', '^SOX', '費城半導體指數'], ['nq', '^IXIC', '那斯達克綜合指數'], ['adr', 'TSM', '台積電 ADR']];
    for (const [k, sym, label] of list) {
      try {
        const q = await yahoo(sym);
        set(k, { label, source: 'Yahoo Finance（' + sym + '）', value: +((q.price - q.prev) / q.prev * 100).toFixed(2), unit: '%', raw: q.price, prevRaw: q.prev, dataTime: new Date(q.time).toISOString(), note: '美股最近一次收盤（或盤中最新）對前一日收盤' });
      } catch (e) { fail(k, 'Yahoo Finance（' + sym + '）', e.message); log('盤前資料失敗', sym, e.message); }
    }
    try {
      const q = await yahoo('TWD=X');
      // 美元兌新台幣下降 = 新台幣升值；1 角 = 0.1 元
      set('fx', { label: '新台幣匯率', source: 'Yahoo Finance（USD/TWD）', value: +((q.prev - q.price) * 10).toFixed(1), unit: '角', raw: q.price, prevRaw: q.prev, dataTime: new Date(q.time).toISOString(), note: '美元兌新台幣，對前一日；正數＝新台幣升值' });
    } catch (e) { fail('fx', 'Yahoo Finance（USD/TWD）', e.message); log('盤前資料失敗 TWD=X', e.message); }
  }

  // 台指期夜盤（盤後交易時段 15:00～隔日 05:00），取近月合約
  async function loadNight() {
    const source = '期交所行情系統（台指期近月・夜盤）';
    try {
      const r = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ MarketType: '1', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = (j.RtData && j.RtData.QuoteList) || [];
      const q = list.find(x => /^TXF/.test(x.SymbolID || '') && toNum(x.CLastPrice) != null && toNum(x.CRefPrice) != null);
      if (!q) throw new Error('查無夜盤成交');
      const last = toNum(q.CLastPrice), ref = toNum(q.CRefPrice);
      const d = String(q.CDate || ''), t = String(q.CTime || '').padStart(6, '0');
      const dataTime = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+08:00` : null;
      set('night', { label: '台指期夜盤', source, value: Math.round(last - ref), unit: '點', raw: last, prevRaw: ref, contract: q.DispCName || q.SymbolID, dataTime, note: '夜盤最新成交價對日盤結算參考價' });
    } catch (e) { fail('night', source, e.message); log('夜盤資料失敗', e.message); }
  }

  // 外資及陸資買賣超金額（最近一個交易日），單位億元
  async function loadForeign() {
    const source = '證交所三大法人買賣金額（BFI82U）';
    const t = tpeNow();
    for (let back = 0; back < 8; back++) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
      if (back === 0 && (t.getHours() < 15 || (t.getHours() === 15 && t.getMinutes() < 30))) continue;
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const date = ymd(d);
      try {
        let j = null;
        for (const u of [`https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${date}&response=json`,
                         `https://www.twse.com.tw/fund/BFI82U?response=json&dayDate=${date}&type=day`]) {
          try { j = await getJSON(u); if (j && (j.data || j.tables)) break; } catch (e) { j = null; }
        }
        const rows = (j && (j.data || (j.tables && j.tables[0] && j.tables[0].data))) || [];
        const row = rows.find(r => String(r[0]).includes('外資及陸資') && String(r[0]).includes('不含')) || rows.find(r => String(r[0]).includes('外資'));
        if (!row) continue;
        const diff = toNum(row[row.length - 1]);
        if (diff == null) continue;
        set('fii', { label: '外資買賣超', source, value: Math.round(diff / 1e8), unit: '億', dataTime: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T15:00:00+08:00`, dataDate: date, note: '外資及陸資（不含外資自營商）最近一個交易日' });
        return;
      } catch (e) { log('外資金額失敗', date, e.message); }
    }
    fail('fii', source, '找不到最近交易日資料');
  }

  async function loadAll() {
    await Promise.allSettled([loadUS(), loadNight()]);
    await loadForeign();
    P.fetchedAt = new Date().toISOString();
  }
  // 05:00～09:10 每 10 分鐘（美股收盤、夜盤結束、開盤前），其他時間每 30 分鐘
  async function loop() {
    try { await loadAll(); } catch (e) { log('盤前排程錯誤', e.message); }
    const t = tpeNow(), m = t.getHours() * 60 + t.getMinutes();
    setTimeout(loop, (m >= 300 && m <= 550) ? 10 * 60000 : 30 * 60000);
  }
  return { P, loop, loadAll };
};
