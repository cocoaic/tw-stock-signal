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

  // ===== 大盤頁完整指數清單 =====
  // freq：daily 每天必看、weekly 每週看、turning 大漲大跌時看、ref 參考
  const IDX = [
    // 一、台股內部
    { k: 'taiex', cat: 'tw', name: '台灣加權指數', freq: 'daily', src: 'mis', code: 'tse_t00.tw' },
    { k: 'otc', cat: 'tw', name: '櫃買指數', freq: 'daily', src: 'mis', code: 'otc_o00.tw' },
    { k: 'tw50', cat: 'tw', name: '臺灣 50 指數', freq: 'ref', src: 'twseIdx', match: ['臺灣50指數', '台灣50指數'], test: n => /^[臺台]灣50指數$/.test(n) },
    { k: 'elec', cat: 'tw', name: '電子類指數', freq: 'ref', src: 'twseIdx', match: ['電子工業類指數', '電子類指數'], test: n => /^電子(工業)?類指數$/.test(n) },
    { k: 'fin', cat: 'tw', name: '金融保險類指數', freq: 'ref', src: 'twseIdx', match: ['金融保險類指數', '金融類指數'], test: n => /^金融(保險)?類指數$/.test(n) },
    { k: 'nonfe', cat: 'tw', name: '未含金融電子股指數（傳產）', freq: 'ref', src: 'twseIdx', match: ['未含金融電子股指數', '未含金融電子指數', '未含金融電子類指數'], test: n => n.startsWith('未含金融電子') && !n.includes('報酬') },
    // 二、美股連動
    { k: 'sox2', cat: 'us', name: '費城半導體指數', freq: 'daily', src: 'yahoo', sym: '^SOX' },
    { k: 'nasdaq', cat: 'us', name: '那斯達克綜合指數', freq: 'ref', src: 'yahoo', sym: '^IXIC' },
    { k: 'spx', cat: 'us', name: '標普 500', freq: 'ref', src: 'yahoo', sym: '^GSPC' },
    { k: 'dji', cat: 'us', name: '道瓊工業指數', freq: 'ref', src: 'yahoo', sym: '^DJI' },
    { k: 'rut', cat: 'us', name: '羅素 2000', freq: 'ref', src: 'yahoo', sym: '^RUT' },
    { k: 'tsm', cat: 'us', name: '台積電 ADR', freq: 'ref', src: 'yahoo', sym: 'TSM' },
    // 三、匯率與債券
    { k: 'usdtwd', cat: 'fx', name: '美元兌新台幣', freq: 'daily', src: 'yahoo', sym: 'TWD=X', dp: 3 },
    { k: 'dxy', cat: 'fx', name: '美元指數 DXY', freq: 'ref', src: 'yahoo', sym: 'DX-Y.NYB' },
    { k: 'usdjpy', cat: 'fx', name: '美元兌日圓', freq: 'ref', src: 'yahoo', sym: 'JPY=X' },
    { k: 'us10y', cat: 'fx', name: '美國 10 年期公債殖利率', freq: 'weekly', src: 'yahoo', sym: '^TNX', unit: '%' },
    { k: 'us2y', cat: 'fx', name: '美國 2 年期公債殖利率', freq: 'ref', src: 'yahoo', sym: '2YY=F', unit: '%' },
    // 四、情緒與風險
    { k: 'vix', cat: 'risk', name: 'VIX 恐慌指數', freq: 'weekly', src: 'yahoo', sym: '^VIX' },
    { k: 'fng', cat: 'risk', name: 'CNN 恐懼與貪婪指數', freq: 'turning', src: 'cnn' },
    { k: 'margin', cat: 'risk', name: '台股融資餘額', freq: 'turning', src: 'margin' },
    { k: 'mratio', cat: 'risk', name: '大盤融資維持率', freq: 'turning', src: 'none', why: '證交所沒有公開大盤整體融資維持率，需要券商或付費資料；這裡改用上一列的融資餘額變化當參考' },
    // 五、亞洲與原物料
    { k: 'n225', cat: 'asia', name: '日經 225', freq: 'ref', src: 'yahoo', sym: '^N225' },
    { k: 'kospi', cat: 'asia', name: '韓國綜合指數', freq: 'ref', src: 'yahoo', sym: '^KS11' },
    { k: 'wti', cat: 'asia', name: '西德州原油 WTI', freq: 'ref', src: 'yahoo', sym: 'CL=F', unit: '美元' },
    { k: 'brent', cat: 'asia', name: '布蘭特原油', freq: 'ref', src: 'yahoo', sym: 'BZ=F', unit: '美元' },
    { k: 'copper', cat: 'asia', name: '銅價', freq: 'ref', src: 'yahoo', sym: 'HG=F', unit: '美元/磅' },
    { k: 'gold', cat: 'asia', name: '黃金', freq: 'ref', src: 'yahoo', sym: 'GC=F', unit: '美元/盎司' },
    // 六、外匯
    { k: 'jpytwd', cat: 'forex', name: '日圓兌新台幣', freq: 'ref', src: 'yahoo', sym: 'JPYTWD=X', dp: 4 },
    { k: 'cnytwd', cat: 'forex', name: '人民幣兌新台幣', freq: 'ref', src: 'derived', dp: 3 },
    { k: 'eurtwd', cat: 'forex', name: '歐元兌新台幣', freq: 'ref', src: 'yahoo', sym: 'EURTWD=X', dp: 3 },
    { k: 'eurusd', cat: 'forex', name: '歐元兌美元', freq: 'ref', src: 'yahoo', sym: 'EURUSD=X', dp: 4 },
    { k: 'gbpusd', cat: 'forex', name: '英鎊兌美元', freq: 'ref', src: 'yahoo', sym: 'GBPUSD=X', dp: 4 },
    { k: 'audusd', cat: 'forex', name: '澳幣兌美元', freq: 'ref', src: 'yahoo', sym: 'AUDUSD=X', dp: 4 },
    { k: 'usdcnh', cat: 'forex', name: '美元兌人民幣', freq: 'ref', src: 'yahoo', sym: 'CNY=X', dp: 4 },
    { k: 'usdkrw', cat: 'forex', name: '美元兌韓元', freq: 'ref', src: 'yahoo', sym: 'KRW=X', dp: 1 },
    // 七、加密貨幣（24 小時交易，比較的是前一個 UTC 日收盤）
    { k: 'btc', cat: 'crypto', name: '比特幣 BTC', freq: 'weekly', src: 'yahoo', sym: 'BTC-USD', dp: 0, unit: '美元' },
    { k: 'eth', cat: 'crypto', name: '以太幣 ETH', freq: 'ref', src: 'yahoo', sym: 'ETH-USD', dp: 2, unit: '美元' },
    { k: 'sol', cat: 'crypto', name: 'Solana SOL', freq: 'ref', src: 'yahoo', sym: 'SOL-USD', dp: 2, unit: '美元' },
    { k: 'xrp', cat: 'crypto', name: '瑞波幣 XRP', freq: 'ref', src: 'yahoo', sym: 'XRP-USD', dp: 4, unit: '美元' },
    { k: 'bnb', cat: 'crypto', name: '幣安幣 BNB', freq: 'ref', src: 'yahoo', sym: 'BNB-USD', dp: 2, unit: '美元' },
    { k: 'doge', cat: 'crypto', name: '狗狗幣 DOGE', freq: 'ref', src: 'yahoo', sym: 'DOGE-USD', dp: 4, unit: '美元' },
    { k: 'bdi', cat: 'asia', name: '波羅的海乾散貨指數 BDI', freq: 'ref', src: 'none', why: '波羅的海交易所的 BDI 需付費授權，沒有穩定的免費資料來源' },
    { k: 'scfi', cat: 'asia', name: '上海出口集裝箱運價 SCFI', freq: 'ref', src: 'none', why: '上海航運交易所沒有可程式讀取的免費接口' }
  ];
  P.idx = {};
  const setIdx = (it, v) => { P.idx[it.k] = Object.assign({ ord: IDX.indexOf(it), k: it.k, cat: it.cat, name: it.name, freq: it.freq, unit: it.unit || '', fetchedAt: new Date().toISOString() }, v); };
  const failIdx = (it, source, msg) => { const o = P.idx[it.k] || {}; P.idx[it.k] = Object.assign({ ord: IDX.indexOf(it), k: it.k, cat: it.cat, name: it.name, freq: it.freq, unit: it.unit || '' }, o, { source, error: msg, failedAt: new Date().toISOString() }); };

  async function idxYahoo(it) {
    const src = 'Yahoo Finance（' + it.sym + '）';
    try {
      const q = await yahoo(it.sym);
      setIdx(it, { source: src, value: q.price, prev: q.prev, change: q.price - q.prev, pct: (q.price - q.prev) / q.prev * 100, dataTime: new Date(q.time).toISOString(), dp: it.dp });
    } catch (e) { failIdx(it, src, e.message); }
  }
  async function idxMis(list) {
    const src = '證交所／櫃買中心即時行情';
    try {
      const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${list.map(x => x.code).join('|')}&json=1&delay=0&_=${Date.now()}`);
      for (const it of list) {
        const q = (j.msgArray || []).find(x => it.code.includes('_' + x.ch) || it.code.includes(x.c + '.tw'));
        if (!q) { failIdx(it, src, '查無資料'); log('指數查無資料', it.code, (j.msgArray || []).map(x => x.c).join(',')); continue; }
        const v = toNum(q.z) ?? toNum(q.pz) ?? toNum(q.h), y = toNum(q.y);
        if (v == null || y == null) { failIdx(it, src, '尚無成交'); continue; }
        const d = String(q.d || ''), t = String(q.t || '13:30:00');
        setIdx(it, { source: j.src ? '鉅亨網（證交所連不上時的備援）' : src, value: v, prev: y, change: v - y, pct: (v - y) / y * 100, dataTime: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t}+08:00` : null });
      }
    } catch (e) { log('台股指數失敗', e.message); list.forEach(it => failIdx(it, src, e.message)); }
  }
  function lastTradingDates(n) {
    const out = [], t = tpeNow();
    for (let i = 0; out.length < n && i < 12; i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
      if (i === 0 && (t.getHours() < 15 || (t.getHours() === 15 && t.getMinutes() < 30))) continue;
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      out.push(ymd(d));
    }
    return out;
  }
  async function idxTwse(list) {
    const src = '證交所每日收盤指數';
    for (const date of lastTradingDates(5)) {
      let j = null;
      for (const u of [`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=IND&response=json`, `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date}&type=IND`]) {
        try { j = await getJSON(u); if (j && j.stat === 'OK') break; } catch (e) { j = null; }
      }
      if (!j || j.stat !== 'OK') continue;
      const rows = [];
      (j.tables || []).forEach(t => (t.data || []).forEach(r => rows.push(r)));
      for (let i = 1; i <= 9; i++) (j['data' + i] || []).forEach(r => rows.push(r));
      let found = 0;
      for (const it of list) {
        const nm = r => String(r[0]).replace(/<[^>]*>/g, '').replace(/\s/g, '');
        const r = rows.find(r => it.match.includes(nm(r))) || (it.test && rows.find(r => it.test(nm(r))));
        if (!r) { failIdx(it, src, '當日資料中找不到'); continue; }
        const v = toNum(r[1]), sign = String(r[2]).includes('-') ? -1 : 1, ch = toNum(r[3]);
        if (v == null) continue;
        const change = ch != null ? sign * ch : null;
        setIdx(it, { source: src, value: v, prev: change != null ? v - change : null, change, pct: change != null ? change / (v - change) * 100 : toNum(r[4]), dataTime: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T13:30:00+08:00` });
        found++;
      }
      if (found) return;
    }
    list.forEach(it => { if (!P.idx[it.k] || !P.idx[it.k].value) failIdx(it, src, '找不到最近交易日資料'); });
  }
  async function idxCnn(it) {
    const src = 'CNN Fear & Greed';
    try {
      const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/' + new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json', Referer: 'https://edition.cnn.com/' },
        signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), f = j.fear_and_greed;
      if (!f) throw new Error('無資料');
      setIdx(it, { source: src, value: Math.round(f.score), prev: f.previous_close != null ? Math.round(f.previous_close) : null, change: f.previous_close != null ? f.score - f.previous_close : null, rating: f.rating, dataTime: f.timestamp ? new Date(f.timestamp).toISOString() : null, weekAgo: f.previous_1_week != null ? Math.round(f.previous_1_week) : null });
    } catch (e) { failIdx(it, src, e.message); }
  }
  async function idxMargin(it) {
    const src = '證交所信用交易統計（MI_MARGN）';
    for (const date of lastTradingDates(5)) {
      let j = null;
      for (const u of [`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${date}&selectType=MS&response=json`, `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${date}&selectType=MS`]) {
        try { j = await getJSON(u); if (j && j.stat === 'OK') break; } catch (e) { j = null; }
      }
      if (!j || j.stat !== 'OK') continue;
      const tables = (j.tables || []).concat(j.creditList ? [{ fields: j.creditFields, data: j.creditList }] : []);
      for (const t of tables) {
        const f = t.fields || [], iPrev = f.findIndex(x => String(x).includes('前日餘額')), iNow = f.findIndex(x => String(x).includes('今日餘額'));
        const row = (t.data || []).find(r => String(r[0]).includes('融資金額'));
        if (row && iPrev >= 0 && iNow >= 0) {
          const now = toNum(row[iNow]), prev = toNum(row[iPrev]); // 仟元
          if (now == null) continue;
          setIdx(it, { source: src, value: +(now / 1e5).toFixed(1), prev: prev != null ? +(prev / 1e5).toFixed(1) : null, change: prev != null ? +((now - prev) / 1e5).toFixed(1) : null, pct: prev ? (now - prev) / prev * 100 : null, unit: '億元', dataTime: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T21:00:00+08:00` });
          return;
        }
      }
    }
    failIdx(it, src, '找不到最近交易日資料');
  }
  async function loadIndices() {
    const by = s => IDX.filter(x => x.src === s);
    by('none').forEach(it => setIdx(it, { unavailable: true, why: it.why, source: '—' }));
    await idxMis(by('mis'));
    for (const it of by('yahoo')) { await idxYahoo(it); await new Promise(r => setTimeout(r, 300)); }
    // 人民幣兌新台幣 = 美元兌台幣 ÷ 美元兌人民幣
    const a = P.idx.usdtwd, b = P.idx.usdcnh, it = IDX.find(x => x.k === 'cnytwd');
    if (a && b && a.value && b.value && a.prev && b.prev) { const v = a.value / b.value, pv = a.prev / b.prev; setIdx(it, { source: '由美元兌台幣 ÷ 美元兌人民幣換算', value: v, prev: pv, change: v - pv, pct: (v - pv) / pv * 100, dataTime: a.dataTime, dp: 3 }); }
    else failIdx(it, '換算', '缺少美元兌台幣或美元兌人民幣');
    await idxCnn(IDX.find(x => x.k === 'fng'));
    await idxTwse(by('twseIdx'));
    await idxMargin(IDX.find(x => x.k === 'margin'));
    P.idxAt = new Date().toISOString();
    const bad = Object.values(P.idx).filter(x => x.error).map(x => x.name);
    if (bad.length) log('指數抓取失敗：', bad.join('、'));
  }

  async function loadAll() {
    loadIndices().catch(e => log('指數載入錯誤', e.message));
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
