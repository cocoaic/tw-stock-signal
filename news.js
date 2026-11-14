// 財經新聞：Google 新聞 RSS（依關鍵字分四大類）＋鉅亨網頭條。只保存標題、來源、時間與連結。
'use strict';

module.exports = function createNews(ctx) {
  const { log } = ctx;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const TTL = 15 * 60000;
  const CATS = [
    { key: 'flash', title: '即時頭條', desc: '鉅亨網頭條，盤中最快', src: 'cnyes' },
    { key: 'macro', title: '1. 央行貨幣政策與總經數據', desc: '決定全球資金水位：Fed、CPI／PCE、非農、台灣央行', q: '聯準會 OR FOMC OR 降息 OR 升息 OR CPI OR PCE OR 非農 OR 央行理監事會' },
    { key: 'tech', title: '2. 科技巨頭與半導體產業', desc: '台股最重要的基本面：巨頭財報與資本支出、展覽、記憶體與面板報價', q: '輝達 OR 台積電 OR 半導體 OR AI伺服器 OR 資本支出 OR 記憶體報價 OR COMPUTEX' },
    { key: 'tw', title: '3. 台灣法說會、營收與政策', desc: '波段選股核心：法說會指引、月營收、政策紅利', q: '法說會 OR 月營收 OR 營收創新高 OR 強韌電網 OR 國防預算 OR 綠能政策' },
    { key: 'geo', title: '4. 地緣政治、關稅與黑天鵝', desc: '突發風險控管：美中科技戰、出口管制、台海、中東、俄烏', q: '關稅 OR 出口管制 OR 晶片禁令 OR 台海 OR 中東 OR 紅海 OR 俄烏' }
  ];
  const cache = new Map(); // key -> { at, items, error }
  const inflight = new Map();

  const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

  async function getText(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, application/json, text/xml, */*' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  async function google(q, n = 12) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await getText(url);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const x = m[1], source = tag(x, 'source');
      let title = tag(x, 'title'); if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      return { title, source, link: tag(x, 'link'), time: new Date(tag(x, 'pubDate')).toISOString() };
    }).filter(i => i.title && i.link);
    // 同標題去重，依時間新到舊
    const seen = new Set();
    return items.filter(i => { const k = i.title.slice(0, 24); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.time.localeCompare(a.time)).slice(0, n);
  }
  async function cnyes(n = 15) {
    const t = await getText(`https://api.cnyes.com/media/api/v1/newslist/category/headline?limit=${n}`);
    const j = JSON.parse(t);
    const list = (j.items && j.items.data) || [];
    if (!list.length) throw new Error('無資料');
    return list.map(x => ({ title: decode(x.title), source: '鉅亨網', link: `https://news.cnyes.com/news/id/${x.newsId}`, time: new Date((x.publishAt || 0) * 1000).toISOString() }));
  }

  async function load(key, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c;
    if (inflight.has(key)) return c || inflight.get(key);
    const p = (async () => {
      try { const items = await fn(); const v = { at: Date.now(), items, error: null }; cache.set(key, v); return v; }
      catch (e) { log('新聞抓取失敗', key, e.message); const v = { at: Date.now() - TTL + 3 * 60000, items: (c && c.items) || [], error: e.message }; cache.set(key, v); return v; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return c || p; // 有舊資料先回舊的，背景更新
  }
  async function all() {
    const out = await Promise.all(CATS.map(async c => {
      const v = await load(c.key, () => c.src === 'cnyes' ? cnyes() : google(c.q));
      return { key: c.key, title: c.title, desc: c.desc, items: v.items, error: v.error, at: new Date(v.at).toISOString() };
    }));
    return out;
  }
  async function forStock(name, code) {
    const q = `"${name}" OR ${code}`;
    const v = await load('s:' + code, () => google(q, 8));
    return { items: v.items, error: v.error, at: new Date(v.at).toISOString() };
  }
  async function search(key, q, k = 8) {
    const v = await load('q:' + key, () => google(q, k));
    return { items: v.items, error: v.error, at: new Date(v.at).toISOString() };
  }
  return { CATS, all, forStock, search };
};
