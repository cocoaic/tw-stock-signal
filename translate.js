// 英文翻譯：職稱、交易類型、州名用固定對照表；公司名與知名人物用 AI 批次翻譯並快取。
'use strict';

module.exports = function createTranslate(ctx) {
  const { ask, enabled, log } = ctx; // ask(prompt) -> JSON
  const TITLE = [
    [/chief executive officer|^ceo$/i, '執行長'], [/chief financial officer|^cfo$/i, '財務長'], [/chief operating officer|^coo$/i, '營運長'],
    [/chief technology officer|^cto$/i, '技術長'], [/chief accounting officer|^cao$/i, '會計長'], [/chief legal officer|^clo$/i, '法務長'],
    [/general counsel|^gc$/i, '法務長'], [/chief business officer|^cbo$/i, '商務長'], [/chief commercial officer/i, '商務長'], [/chief marketing officer|^cmo$/i, '行銷長'],
    [/chief medical officer/i, '醫療長'], [/chief scientific officer|^cso$/i, '科學長'], [/chief strategy officer/i, '策略長'], [/chief revenue officer|^cro$/i, '營收長'],
    [/chief product officer|^cpo$/i, '產品長'], [/chief information officer|^cio$/i, '資訊長'], [/chief people officer|chief human resources/i, '人資長'],
    [/chief investment officer/i, '投資長'], [/chief risk officer/i, '風控長'], [/chief compliance officer/i, '法遵長'],
    [/^(cob|chairman|chair|board chair)$/i, '董事長'], [/vice chair/i, '副董事長'], [/^(pres|president)$/i, '總裁'], [/^evp$|executive vice president/i, '執行副總'],
    [/^svp$|senior vice president/i, '資深副總'], [/^vp$|vice president/i, '副總'], [/^(dir|director)$/i, '董事'], [/^10%$/, '持股逾 10% 大股東'],
    [/^(sec|secretary)$/i, '秘書'], [/^(treas|treasurer)$/i, '財務主管'], [/^gm$|general manager/i, '總經理'], [/^former/i, '前任'], [/^see remarks$/i, '見備註']
  ];
  function title(t) {
    if (!t) return '';
    return String(t).split(/,\s*/).map(p => { const x = p.trim(); const m = TITLE.find(([re]) => re.test(x)); return m ? m[1] : x; }).join('、');
  }
  const TYPES = { P: '買進', S: '賣出', 'S+OE': '賣出（行使選擇權後）', M: '行使選擇權', X: '行使選擇權', F: '扣稅繳股', G: '贈與', D: '處分', A: '獲配股票', C: '轉換', W: '繼承' };
  function ttype(t) {
    const s = String(t || ''), k = s.split(' - ')[0].trim(), rest = s.split(' - ')[1] || '';
    if (k === 'S' && /\+OE/.test(rest)) return TYPES['S+OE'];
    return TYPES[k] || s;
  }
  const STATES = { AL: '阿拉巴馬州', AK: '阿拉斯加州', AZ: '亞利桑那州', AR: '阿肯色州', CA: '加州', CO: '科羅拉多州', CT: '康乃狄克州', DE: '德拉瓦州', FL: '佛羅里達州', GA: '喬治亞州',
    HI: '夏威夷州', ID: '愛達荷州', IL: '伊利諾州', IN: '印第安納州', IA: '愛荷華州', KS: '堪薩斯州', KY: '肯塔基州', LA: '路易斯安那州', ME: '緬因州', MD: '馬里蘭州', MA: '麻州',
    MI: '密西根州', MN: '明尼蘇達州', MS: '密西西比州', MO: '密蘇里州', MT: '蒙大拿州', NE: '內布拉斯加州', NV: '內華達州', NH: '新罕布夏州', NJ: '紐澤西州', NM: '新墨西哥州',
    NY: '紐約州', NC: '北卡羅來納州', ND: '北達科他州', OH: '俄亥俄州', OK: '奧克拉荷馬州', OR: '奧勒岡州', PA: '賓州', RI: '羅德島州', SC: '南卡羅來納州', SD: '南達科他州',
    TN: '田納西州', TX: '德州', UT: '猶他州', VT: '佛蒙特州', VA: '維吉尼亞州', WA: '華盛頓州', WV: '西維吉尼亞州', WI: '威斯康辛州', WY: '懷俄明州', DC: '華盛頓特區',
    PR: '波多黎各', GU: '關島', VI: '美屬維京群島', AS: '美屬薩摩亞', MP: '北馬利安納群島' };
  function district(sd) {
    const m = String(sd || '').match(/^([A-Z]{2})(\d+)?$/); if (!m) return sd || '';
    const st = STATES[m[1]] || m[1]; const n = m[2] ? +m[2] : null;
    return n ? `${st}第 ${n} 選區` : n === 0 ? `${st}（全州單一選區）` : st;
  }

  // ---------- AI：公司名與人名 ----------
  const zh = new Map(); // key -> 中文（空字串代表沒有通行譯名）
  let busy = null;
  async function fill(companies = [], people = []) {
    const need = [...new Set(companies.map(c => 'c:' + c).concat(people.map(p => 'p:' + p)))].filter(k => k.length > 2 && !zh.has(k)).slice(0, 80);
    if (!need.length || !enabled()) return;
    if (busy) { await busy.catch(() => {}); return fill(companies, people); }
    busy = (async () => {
      const prompt = `請把下列英文翻成台灣常用的繁體中文。規則：
- c: 開頭是公司名：給台灣媒體常用的中文名（例如 Apple→蘋果、Nvidia→輝達、Berkshire Hathaway→波克夏）；沒有通行中文名的就給簡短意譯，並保留英文縮寫。去掉 Inc、Corp 等字尾。
- p: 開頭是人名：只有台灣媒體有常見中文譯名的名人才給（例如 Jen-Hsun Huang→黃仁勳、Nancy Pelosi→裴洛西、Elon Musk→馬斯克），一般人一律給空字串，不要自己音譯。
只輸出 JSON 物件，鍵為原字串（含 c: 或 p: 前綴），值為中文。
${JSON.stringify(need)}`;
      try {
        const out = await ask(prompt);
        for (const k of need) zh.set(k, typeof out[k] === 'string' ? out[k].trim() : '');
      } catch (e) { log('翻譯失敗', e.message); need.forEach(k => zh.set(k, null)); setTimeout(() => need.forEach(k => { if (zh.get(k) === null) zh.delete(k); }), 30 * 60000); }
    })();
    try { await busy; } finally { busy = null; }
  }
  const company = c => (c && zh.get('c:' + c)) || '';
  const person = p => (p && zh.get('p:' + p)) || '';
  return { title, ttype, district, fill, company, person };
};
