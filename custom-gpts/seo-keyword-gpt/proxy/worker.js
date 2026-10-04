// SEO 키워드 리서처 GPT용 프록시 (Cloudflare Worker)
//
// GPT Actions는 API 키 헤더를 하나만 보낼 수 있고 HMAC 서명도 못 만들기 때문에,
// 모든 비밀 키는 이 Worker가 보관하고 GPT는 PROXY_API_KEY 하나로만 인증한다.
//
// 환경 변수 (wrangler secret put ...):
//   PROXY_API_KEY            GPT → Worker 인증용 (직접 만든 임의 문자열)
//   NAVER_AD_ACCESS_LICENSE  네이버 검색광고 API 액세스 라이선스
//   NAVER_AD_SECRET          네이버 검색광고 API 비밀 키
//   NAVER_AD_CUSTOMER_ID     네이버 검색광고 고객 ID
//   NAVER_CLIENT_ID          네이버 개발자센터 애플리케이션 Client ID (검색 + 데이터랩)
//   NAVER_CLIENT_SECRET      네이버 개발자센터 애플리케이션 Client Secret
//   KE_API_KEY               (선택) Keywords Everywhere API 키 — 구글 검색량/CPC
//   MAX_BATCH                (선택) analyze 1회당 최대 키워드 수, 기본 15
//                            (무료 플랜 서브요청 50개 제한 때문. 유료 플랜이면 50까지 올려도 됨)

const SCORING_VERSION = 'v1';
const enc = new TextEncoder();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/privacy') {
      return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const auth = req.headers.get('authorization') || '';
    if (!env.PROXY_API_KEY || auth !== `Bearer ${env.PROXY_API_KEY}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid JSON body' }, 400);
    }

    try {
      if (url.pathname === '/expand') return json(await expand(body, env));
      if (url.pathname === '/analyze') return json(await analyze(body, env));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, e instanceof BadRequest ? 400 : 500);
    }
  },
};

// ---------------------------------------------------------------------------
// /expand : 핵심 단어 → 연관·자동완성 후보 키워드
// ---------------------------------------------------------------------------
async function expand(body, env) {
  const seeds = uniq((body.seeds || []).map(String).map((s) => s.trim()).filter(Boolean)).slice(0, 5);
  if (!seeds.length) throw new BadRequest('seeds is required (1~5 keywords)');
  const limit = clampInt(body.limit, 20, 200, 120);
  const hl = body.language || 'ko';
  const gl = body.country || 'kr';

  const pool = new Map(); // normalized → candidate
  const add = (keyword, volume, source) => {
    const k = String(keyword || '').trim();
    if (!k) return;
    const n = norm(k);
    const cur = pool.get(n) || { keyword: k, monthlyVolume: null, sources: [] };
    if (volume != null && (cur.monthlyVolume == null || volume > cur.monthlyVolume)) cur.monthlyVolume = volume;
    if (!cur.sources.includes(source)) cur.sources.push(source);
    pool.set(n, cur);
  };

  const jobs = [];

  // 1) 검색광고 연관 키워드 (검색량 포함)
  if (hasNaverAd(env)) {
    jobs.push(
      naverKeywordTool(seeds, env).then((list) => {
        for (const r of list) add(r.relKeyword, r.pc + r.mobile, 'naver_ad');
      })
    );
  }

  // 2) 자동완성 (구글 / 네이버)
  for (const s of seeds) {
    for (const q of [s, `${s} `]) {
      jobs.push(googleSuggest(q, hl, gl).then((list) => list.forEach((k) => add(k, null, 'google_suggest'))));
    }
    jobs.push(naverSuggest(s).then((list) => list.forEach((k) => add(k, null, 'naver_suggest'))));
  }

  // 3) (선택) 구글 연관 키워드
  if (env.KE_API_KEY && body.includeGoogleRelated) {
    for (const s of seeds.slice(0, 2)) {
      jobs.push(keRelated(s, env).then((list) => list.forEach((k) => add(k, null, 'ke_related'))));
    }
  }

  await Promise.allSettled(jobs);
  seeds.forEach((s) => add(s, null, 'seed'));

  const candidates = [...pool.values()]
    .sort((a, b) => (b.monthlyVolume ?? -1) - (a.monthlyVolume ?? -1))
    .slice(0, limit);

  return { seeds, count: candidates.length, candidates };
}

// ---------------------------------------------------------------------------
// /analyze : 키워드별 지표 수집 + 점수 계산
// ---------------------------------------------------------------------------
async function analyze(body, env) {
  const maxBatch = clampInt(env.MAX_BATCH, 1, 50, 15);
  const keywords = uniq((body.keywords || []).map(String).map((s) => s.trim()).filter(Boolean));
  if (!keywords.length) throw new BadRequest('keywords is required');
  if (keywords.length > maxBatch) throw new BadRequest(`too many keywords: max ${maxBatch} per call, split into batches`);
  const country = body.country || 'kr';

  const [volumes, blogs, trends, google] = await Promise.all([
    hasNaverAd(env) ? naverVolumes(keywords, env).catch(() => new Map()) : new Map(),
    hasNaverOpen(env) ? Promise.all(keywords.map((k) => blogStats(k, env).catch(() => null))) : keywords.map(() => null),
    hasNaverOpen(env) ? naverTrends(keywords, env).catch(() => new Map()) : new Map(),
    env.KE_API_KEY ? keKeywordData(keywords, country, env).catch(() => new Map()) : new Map(),
  ]);

  const results = keywords.map((keyword, i) => {
    const n = norm(keyword);
    const vol = volumes.get(n) || null;
    const blog = blogs[i];
    const trend = trends.get(keyword) || null;
    const g = google.get(n) || null;

    const metrics = {
      monthlyVolume: vol ? vol.pc + vol.mobile : g ? g.vol : null,
      monthlyPc: vol ? vol.pc : null,
      monthlyMobile: vol ? vol.mobile : null,
      googleVolume: g ? g.vol : null,
      cpc: g ? g.cpc : null,
      adCompetition: vol ? vol.compIdx : null,
      blogDocs: blog ? blog.total : null,
      competitionRatio: null,
      growthPct: trend ? trend.growthPct : null,
      peakMonth: trend ? trend.peakMonth : null,
      trendSeries: trend ? trend.series : null,
      top10AvgAgeDays: blog ? blog.top10AvgAgeDays : null,
      recent30dPosts: blog ? blog.recent30dPosts : null,
    };
    if (metrics.monthlyVolume != null && metrics.blogDocs != null) {
      metrics.competitionRatio = round(metrics.blogDocs / Math.max(metrics.monthlyVolume, 1), 2);
    }

    const score = scoreKeyword(metrics);
    return { keyword, grade: grade(score.total), score, metrics, dataQuality: score.missing.length ? 'partial' : 'full' };
  });

  results.sort((a, b) => b.score.total - a.score.total || (b.metrics.monthlyVolume ?? 0) - (a.metrics.monthlyVolume ?? 0));

  return {
    scoringVersion: SCORING_VERSION,
    generatedAt: new Date().toISOString(),
    periods: { volume: 'last 30 days', trend: 'last 12 full months', posts: 'last 30 days' },
    results,
  };
}

// ---------------------------------------------------------------------------
// 점수 (knowledge/keyword-scoring-guide.md 와 동일한 공식)
// ---------------------------------------------------------------------------
function scoreKeyword(m) {
  const missing = [];

  // 수요 40
  let demand = 0;
  if (m.monthlyVolume != null) demand = 40 * clamp01((Math.log10(Math.max(m.monthlyVolume, 1)) - 1) / 4);
  else missing.push('monthlyVolume');

  // 경쟁 30
  let competition = 15;
  if (m.competitionRatio != null) {
    const r = Math.max(m.competitionRatio, 0.001);
    competition = 30 * clamp01(1 - (Math.log10(r) - Math.log10(0.5)) / 2);
  } else missing.push('competitionRatio');

  // 트렌드 15
  let trend = 7.5;
  if (m.growthPct != null) trend = 15 * clamp01((m.growthPct / 100 + 0.5) / 1.0);
  else missing.push('growthPct');

  // 노출 기회 15
  let freshness = 4;
  if (m.top10AvgAgeDays != null) freshness = 8 * clamp01((m.top10AvgAgeDays - 30) / 335);
  else missing.push('top10AvgAgeDays');
  let velocity = 3.5;
  if (m.recent30dPosts != null) velocity = 7 * clamp01(1 - (m.recent30dPosts - 10) / 90);
  else missing.push('recent30dPosts');
  const exposure = freshness + velocity;

  return {
    total: round(demand + competition + trend + exposure, 1),
    demand: round(demand, 1),
    competition: round(competition, 1),
    trend: round(trend, 1),
    exposure: round(exposure, 1),
    missing,
  };
}

function grade(total) {
  if (total >= 80) return 'S';
  if (total >= 65) return 'A';
  if (total >= 50) return 'B';
  if (total >= 35) return 'C';
  return 'D';
}

// ---------------------------------------------------------------------------
// 네이버 검색광고 API (월간 검색량, 광고 경쟁도)
// ---------------------------------------------------------------------------
function hasNaverAd(env) {
  return env.NAVER_AD_ACCESS_LICENSE && env.NAVER_AD_SECRET && env.NAVER_AD_CUSTOMER_ID;
}

async function naverAdHeaders(env, method, uri) {
  const ts = Date.now().toString();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.NAVER_AD_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${method}.${uri}`));
  return {
    'X-Timestamp': ts,
    'X-API-KEY': env.NAVER_AD_ACCESS_LICENSE,
    'X-Customer': String(env.NAVER_AD_CUSTOMER_ID),
    'X-Signature': btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
}

// hintKeywords 최대 5개, 공백 불가
async function naverKeywordTool(hints, env) {
  const uri = '/keywordstool';
  const qs = new URLSearchParams({ hintKeywords: hints.map((h) => h.replace(/\s+/g, '')).join(','), showDetail: '1' });
  const res = await fetch(`https://api.searchad.naver.com${uri}?${qs}`, { headers: await naverAdHeaders(env, 'GET', uri) });
  if (!res.ok) throw new Error(`naver ad ${res.status}`);
  const data = await res.json();
  return (data.keywordList || []).map((r) => ({
    relKeyword: r.relKeyword,
    pc: toCount(r.monthlyPcQcCnt),
    mobile: toCount(r.monthlyMobileQcCnt),
    compIdx: r.compIdx || null,
  }));
}

async function naverVolumes(keywords, env) {
  const out = new Map();
  const wanted = new Set(keywords.map(norm));
  const batches = chunk(keywords, 5);
  const lists = await Promise.all(batches.map((b) => naverKeywordTool(b, env).catch(() => [])));
  for (const list of lists) {
    for (const r of list) {
      const n = norm(r.relKeyword);
      if (wanted.has(n) && !out.has(n)) out.set(n, r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 네이버 오픈 API (블로그 문서 수, 데이터랩 트렌드)
// ---------------------------------------------------------------------------
function hasNaverOpen(env) {
  return env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET;
}

function naverOpenHeaders(env) {
  return { 'X-Naver-Client-Id': env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET };
}

async function naverBlog(query, sort, display, env) {
  const qs = new URLSearchParams({ query, sort, display: String(display), start: '1' });
  const res = await fetch(`https://openapi.naver.com/v1/search/blog.json?${qs}`, { headers: naverOpenHeaders(env) });
  if (!res.ok) throw new Error(`naver blog ${res.status}`);
  return res.json();
}

async function blogStats(keyword, env) {
  const [bySim, byDate] = await Promise.all([naverBlog(keyword, 'sim', 10, env), naverBlog(keyword, 'date', 100, env)]);
  const now = Date.now();
  const ageDays = (d) => (now - parseYmd(d)) / 86400000;

  const top = (bySim.items || []).map((it) => it.postdate).filter(Boolean);
  const top10AvgAgeDays = top.length ? Math.round(top.reduce((s, d) => s + ageDays(d), 0) / top.length) : null;
  const recent30dPosts = (byDate.items || []).filter((it) => it.postdate && ageDays(it.postdate) <= 30).length;

  return { total: bySim.total ?? byDate.total ?? null, top10AvgAgeDays, recent30dPosts };
}

async function naverTrends(keywords, env) {
  const out = new Map();
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // 지난달 말일
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));

  await Promise.all(
    chunk(keywords, 5).map(async (batch) => {
      const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
        method: 'POST',
        headers: { ...naverOpenHeaders(env), 'content-type': 'application/json' },
        body: JSON.stringify({
          startDate: ymd(start),
          endDate: ymd(end),
          timeUnit: 'month',
          keywordGroups: batch.map((k) => ({ groupName: k, keywords: [k] })),
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const r of data.results || []) {
        const series = (r.data || []).map((p) => ({ period: p.period.slice(0, 7), ratio: round(p.ratio, 1) }));
        const vals = series.map((p) => p.ratio);
        let growthPct = null;
        if (vals.length >= 6) {
          const last3 = avg(vals.slice(-3));
          const prev3 = avg(vals.slice(-6, -3));
          growthPct = prev3 > 0 ? round((last3 / prev3 - 1) * 100, 1) : last3 > 0 ? 100 : null;
        }
        const peak = series.reduce((m, p) => (p.ratio > (m ? m.ratio : -1) ? p : m), null);
        out.set(r.title, { growthPct, peakMonth: peak ? peak.period : null, series });
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// 자동완성
// ---------------------------------------------------------------------------
async function googleSuggest(q, hl, gl) {
  try {
    const qs = new URLSearchParams({ client: 'firefox', hl, gl, q });
    const res = await fetch(`https://suggestqueries.google.com/complete/search?${qs}`);
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    return Array.isArray(data[1]) ? data[1] : [];
  } catch {
    return [];
  }
}

// 비공식 엔드포인트라 실패해도 무시
async function naverSuggest(q) {
  try {
    const qs = new URLSearchParams({ q, con: '1', frm: 'nv', ans: '2', r_format: 'json', r_enc: 'UTF-8', r_unicode: '0', t_koreng: '1', q_enc: 'UTF-8', st: '100' });
    const res = await fetch(`https://ac.search.naver.com/nx/ac?${qs}`);
    if (!res.ok) return [];
    const data = await res.json();
    return ((data.items && data.items[0]) || []).map((x) => (Array.isArray(x) ? x[0] : x)).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// (선택) Keywords Everywhere API — 구글 검색량·CPC
// ---------------------------------------------------------------------------
async function keKeywordData(keywords, country, env) {
  const form = new URLSearchParams({ dataSource: 'gkp', country, currency: 'krw' });
  keywords.forEach((k) => form.append('kw[]', k));
  const res = await fetch('https://api.keywordseverywhere.com/v1/get_keyword_data', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.KE_API_KEY}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) throw new Error(`ke ${res.status}`);
  const data = await res.json();
  const out = new Map();
  for (const r of data.data || []) {
    out.set(norm(r.keyword), { vol: r.vol ?? null, cpc: r.cpc && r.cpc.value != null ? Number(r.cpc.value) : null });
  }
  return out;
}

async function keRelated(keyword, env) {
  const form = new URLSearchParams({ keyword, num: '20' });
  const res = await fetch('https://api.keywordseverywhere.com/v1/get_related_keywords', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.KE_API_KEY}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((x) => (typeof x === 'string' ? x : x.keyword)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
class BadRequest extends Error {}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
const uniq = (arr) => [...new Map(arr.map((s) => [norm(s), s])).values()];
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const toCount = (v) => (typeof v === 'number' ? v : /</.test(String(v)) ? 5 : Number(v) || 0);
const ymd = (d) => d.toISOString().slice(0, 10);
const parseYmd = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

const PRIVACY_HTML = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>개인정보 처리방침</title>
<body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>개인정보 처리방침</h1>
<p>이 서비스는 사용자가 입력한 검색 키워드만 받아 공개 검색 통계를 조회하고 결과를 반환합니다.
키워드와 결과는 저장하지 않으며, 개인을 식별할 수 있는 정보를 수집하지 않습니다.</p>
</body></html>`;
