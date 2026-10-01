/**
 * ═══════════════════════════════════════════════════════════════
 * 원산지위반위험탐색툴 — API 프록시 (GAS 백엔드) v2.2
 * ═══════════════════════════════════════════════════════════════
 *
 * v2.2 개선사항:
 * - Gemini 응답 형식을 원본 proxy.py와 동일하게 (analysis, tokens, tried_models 등)
 * - Gemini 모델 fallback 체인 (429·404·503·500 발생 시 다음 모델 자동 전환)
 * - 사용량 카운터
 * - listGeminiModels·프록시 상태 페이지
 *
 * 스크립트 속성 (⚙️ 프로젝트 설정):
 *   - GEMINI_KEY       : Google Gemini API 키
 *   - GEMINI_MODEL     : 기본 모델 (예: gemini-flash-latest)
 *   - COMTRADE_KEY     : UN Comtrade Primary Key
 *   - DATA_GO_KR_KEY   : 공공데이터포털(data.go.kr) 관세청 무역통계 API 키
 *                        (customs_origin_detect·component_inflow·customs_trade_stat 에서 사용)
 * ═══════════════════════════════════════════════════════════════
 */

const PROPS = PropertiesService.getScriptProperties();
const GEMINI_KEY     = PROPS.getProperty('GEMINI_KEY') || '';
const GEMINI_MODEL   = PROPS.getProperty('GEMINI_MODEL') || 'gemini-flash-latest';
const COMTRADE_KEY   = PROPS.getProperty('COMTRADE_KEY') || '';
const DATA_GO_KR_KEY = PROPS.getProperty('DATA_GO_KR_KEY') || '';

// Gemini 모델 fallback 체인 (proxy.py와 동일)
const GEMINI_FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-2.5-pro'
];


// ══════════════════════════════════════════════════════════
// [1] 웹앱 진입점
// ══════════════════════════════════════════════════════════

function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleAction(e.parameter.action, e.parameter, {});
  }
  return jsonResponse({
    ok: true,
    service: '원산지위반위험탐색툴 API 프록시',
    version: 'v2.2',
    gemini: !!GEMINI_KEY,
    comtrade: !!COMTRADE_KEY,
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    const action = payload.action || '';
    const params = payload.params || {};
    const body = payload.body || {};
    return handleAction(action, params, body);
  } catch (err) {
    return jsonResponse({ success: false, error: 'POST 파싱 오류: ' + String(err) });
  }
}

function handleAction(action, params, body) {
  switch (action) {
    case 'health':          return jsonResponse(healthCheck());
    case 'gemini':          return jsonResponse(callGemini(body.prompt || '', body.options || {}));
    case 'gemini_usage':    return jsonResponse(geminiUsage());
    case 'gemini_models':   return jsonResponse(listGeminiModels());
    case 'comtrade':        return jsonResponse(callComtrade(params));
    case 'worldbank':       return jsonResponse(callWorldBank(params.country || '', params.indicator || ''));
    case 'trade_flow':      return jsonResponse(tradeFlow(params));
    case 'trade_origin':    return jsonResponse(tradeOrigin(params));
    case 'faostat_trade':   return jsonResponse(faostatTradeMatrix(params));
    case 'faostat_prod':    return jsonResponse(faostatProduction(params));
    case 'oecd_tiva':       return jsonResponse(oecdTiva(params));
    case 'industry':        return jsonResponse(industryProfile(params));
    case 'country_iso':     return jsonResponse({ success: false, error: 'country_iso 미구현' });
    case 'cbp_cross_search':     return jsonResponse(cbpCrossSearch(params));
    case 'cbp_cross_summarize':  return jsonResponse(cbpCrossSummarize(body));
    case 'cbp_cross_translate':  return jsonResponse(cbpCrossTranslate(body));
    case 'bom_suggest':          return jsonResponse(bomSuggest(body));
    case 'bom_review':           return jsonResponse(bomReview(body));
    case 'origin_detect':        return jsonResponse(originDetect(params));
    case 'component_inflow':     return jsonResponse(componentInflow(params));
    case 'trade_stat':           return jsonResponse(customsTradeStat(params));
    default:
      return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ══════════════════════════════════════════════════════════
// [2] Health Check
// ══════════════════════════════════════════════════════════

function healthCheck() {
  return {
    ok: true,
    proxy: 'ok',
    gemini: !!GEMINI_KEY,
    comtrade: !!COMTRADE_KEY,
    timestamp: new Date().toISOString()
  };
}


// ══════════════════════════════════════════════════════════
// [3] Gemini API (fallback 체인 포함)
// ══════════════════════════════════════════════════════════

function callGemini(prompt, options) {
  options = options || {};
  const requestedModel = options.model || GEMINI_MODEL;
  const temperature = (options.temperature !== undefined) ? options.temperature : 0.3;
  const maxOutputTokens = options.maxOutputTokens || 8192;

  if (!GEMINI_KEY) return { success: false, error: 'GEMINI_KEY 미설정' };
  if (!prompt || !prompt.trim()) return { success: false, error: 'prompt 비어있음' };

  // 모델 후보 리스트: 요청 모델 + fallback (중복 제거)
  const modelCandidates = [requestedModel];
  GEMINI_FALLBACK_MODELS.forEach(m => {
    if (modelCandidates.indexOf(m) < 0) modelCandidates.push(m);
  });

  // 캐시 확인
  let cacheKey = null;
  if (prompt.length < 5000) {
    cacheKey = 'gemini_' + Utilities.base64Encode(Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, prompt + '|' + requestedModel
    )).replace(/[^a-zA-Z0-9]/g, '').substring(0, 100);

    const cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      _recordUsage(true);
      return {
        success: true,
        analysis: cached,       // ★ 원본이 참조하는 필드
        text: cached,           // 하위 호환
        model: requestedModel,
        cached: true,
        tokens: { total: 0, prompt: 0, response: 0 }
      };
    }
  }

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxOutputTokens,
      topP: 0.95,
      topK: 40,
      thinkingConfig: { thinkingBudget: 0 }
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  let lastError = 'unknown';
  let usedModel = null;
  let respJson = null;

  // 여러 모델 순차 시도
  for (let i = 0; i < modelCandidates.length; i++) {
    const model = modelCandidates[i];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(model) + ':generateContent?key=' + GEMINI_KEY;

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const status = response.getResponseCode();
      const respBody = response.getContentText();

      if (status === 200) {
        respJson = JSON.parse(respBody);
        usedModel = model;
        break;
      } else if (status === 429 || status === 404 || status === 503 || status === 500) {
        // 한도 초과·모델 없음·서버 과부하·서버 오류 → 다음 후보
        lastError = 'HTTP ' + status + ' (' + model + ')';
        Utilities.sleep(500);
        continue;
      } else {
        // 기타 오류 (400, 401, 403 등) → 즉시 종료
        return { success: false, error: 'Gemini ' + status + ' (' + model + '): ' + respBody.substring(0, 300) };
      }
    } catch (err) {
      lastError = String(err) + ' (' + model + ')';
      continue;
    }
  }

  if (!usedModel) {
    _recordUsage(false, null, lastError);
    return { success: false, error: '모든 모델 실패: ' + lastError, tried_models: modelCandidates };
  }

  // 응답에서 text 추출
  const text = respJson && respJson.candidates && respJson.candidates[0] &&
               respJson.candidates[0].content && respJson.candidates[0].content.parts &&
               respJson.candidates[0].content.parts[0] && respJson.candidates[0].content.parts[0].text;

  if (!text) {
    _recordUsage(false, usedModel, 'no_text');
    return {
      success: false,
      error: 'Gemini 응답에 텍스트 없음',
      finishReason: respJson.candidates && respJson.candidates[0] && respJson.candidates[0].finishReason,
      model: usedModel
    };
  }

  // 캐시 저장
  if (cacheKey && text.length < 100000) {
    try { CacheService.getScriptCache().put(cacheKey, text, 21600); } catch (e) {}
  }

  _recordUsage(false, usedModel);

  // ★ 원본 proxy.py 응답 형식 (analysis 필드 필수)
  const usage = respJson.usageMetadata || {};
  return {
    success: true,
    analysis: text,                                // ← 원본 프론트가 참조
    text: text,                                    // 하위 호환
    model: usedModel,
    model_requested: requestedModel,
    tried_models: modelCandidates,
    fallback_used: usedModel !== requestedModel,
    finish_reason: respJson.candidates && respJson.candidates[0] && respJson.candidates[0].finishReason,
    tokens: {
      prompt: usage.promptTokenCount || 0,
      response: usage.candidatesTokenCount || 0,
      total: usage.totalTokenCount || 0
    }
  };
}


// ══════════════════════════════════════════════════════════
// [4] 사용량 추적
// ══════════════════════════════════════════════════════════

function _recordUsage(wasCached, model, error) {
  try {
    const cache = CacheService.getScriptCache();
    const today = Utilities.formatDate(new Date(), 'GMT+9', 'yyyy-MM-dd');

    if (wasCached) {
      const cached = parseInt(cache.get('gemini_cached_' + today) || '0');
      cache.put('gemini_cached_' + today, String(cached + 1), 86400);
    } else {
      const calls = parseInt(cache.get('gemini_calls_' + today) || '0');
      cache.put('gemini_calls_' + today, String(calls + 1), 86400);
      if (model) {
        cache.put('gemini_last_model', model, 21600);
        cache.put('gemini_last_at', new Date().toISOString(), 21600);
      }
      if (error) {
        const errs = parseInt(cache.get('gemini_errors_' + today) || '0');
        cache.put('gemini_errors_' + today, String(errs + 1), 86400);
        cache.put('gemini_last_error', String(error).substring(0, 200), 21600);
      }
    }
  } catch (e) {}
}

function geminiUsage() {
  const cache = CacheService.getScriptCache();
  const today = Utilities.formatDate(new Date(), 'GMT+9', 'yyyy-MM-dd');
  const todayCalls = parseInt(cache.get('gemini_calls_' + today) || '0');
  const cachedHits = parseInt(cache.get('gemini_cached_' + today) || '0');
  const errors = parseInt(cache.get('gemini_errors_' + today) || '0');
  const lastModel = cache.get('gemini_last_model') || '';
  const lastAt = cache.get('gemini_last_at') || null;
  const lastError = cache.get('gemini_last_error') || null;

  // 한도 추정 (모델별)
  let rpmLimit = 15, rpdLimit = 200;
  const lm = lastModel.toLowerCase();
  if (lm.indexOf('lite') >= 0)          { rpmLimit = 30; rpdLimit = 1500; }
  else if (lm.indexOf('2.5-flash') >= 0){ rpmLimit = 10; rpdLimit = 250; }
  else if (lm.indexOf('pro') >= 0)      { rpmLimit = 5;  rpdLimit = 100; }

  return {
    summary: {
      real_calls: todayCalls,
      cached_hits: cachedHits,
      errors: errors,
      today_calls: todayCalls,
      rpm_last_60s: 0,
      uptime_minutes: 0
    },
    free_tier_estimate: {
      model_basis: lastModel || '(미사용)',
      rpm_limit: rpmLimit,
      rpm_used: 0,
      rpm_remaining: rpmLimit,
      rpd_limit: rpdLimit,
      rpd_used: todayCalls,
      rpd_remaining: Math.max(0, rpdLimit - todayCalls),
      rpd_percent: rpdLimit ? Math.round(todayCalls / rpdLimit * 1000) / 10 : 0,
      _note: 'GAS 프록시 - 사용량은 캐시 기반 일일 집계'
    },
    by_day: {},
    last_call_at: lastAt,
    last_model_used: lastModel || null,
    last_error: lastError
  };
}

function listGeminiModels() {
  if (!GEMINI_KEY) return { success: false, error: 'GEMINI_KEY 미설정' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_KEY;
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'API ' + response.getResponseCode() };
    }
    return { success: true, data: JSON.parse(response.getContentText()) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}


// ══════════════════════════════════════════════════════════
// [5] UN Comtrade
// ══════════════════════════════════════════════════════════

function callComtrade(params) {
  params = params || {};
  const reporter = params.reporter || '';
  const partner  = params.partner  || '';
  const year     = params.year     || '';
  const hs       = params.hs       || '';
  const flowCode = params.flowCode || 'M';

  if (!COMTRADE_KEY) return { success: false, error: 'COMTRADE_KEY 미설정' };

  const cacheKey = 'ct_' + [reporter, partner, year, hs, flowCode].join('_');
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return { success: true, data: JSON.parse(cached), cached: true };

  const url = 'https://comtradeapi.un.org/data/v1/get/C/A/HS' +
              '?reporterCode=' + reporter +
              '&partnerCode=' + partner +
              '&period=' + year +
              '&cmdCode=' + hs +
              '&flowCode=' + flowCode +
              '&subscription-key=' + COMTRADE_KEY;

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'Comtrade ' + response.getResponseCode() };
    }
    const json = JSON.parse(response.getContentText());
    try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(json), 21600); } catch (e) {}
    return { success: true, data: json };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}


// ══════════════════════════════════════════════════════════
// [6] World Bank
// ══════════════════════════════════════════════════════════

function callWorldBank(country, indicator) {
  if (!country || !indicator) return { success: false, error: 'country/indicator 필요' };

  const cacheKey = 'wb_' + country + '_' + indicator;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return { success: true, data: JSON.parse(cached), cached: true };

  const url = 'https://api.worldbank.org/v2/country/' + country +
              '/indicator/' + indicator + '?format=json&per_page=100';

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'WorldBank ' + response.getResponseCode() };
    }
    const json = JSON.parse(response.getContentText());
    try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(json), 21600); } catch (e) {}
    return { success: true, data: json };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}


// ══════════════════════════════════════════════════════════
// [7] 공용 참조 데이터 (proxy.py 와 동기화)
// ══════════════════════════════════════════════════════════

// 한글 국가명 → ISO 코드 (Comtrade·World Bank용)
const COUNTRY_ISO = {
  "한국": { m49: 410, iso3: "KOR" },
  "중국": { m49: 156, iso3: "CHN" },
  "베트남": { m49: 704, iso3: "VNM" },
  "일본": { m49: 392, iso3: "JPN" },
  "미국": { m49: 842, iso3: "USA" },
  "태국": { m49: 764, iso3: "THA" },
  "인도네시아": { m49: 360, iso3: "IDN" },
  "말레이시아": { m49: 458, iso3: "MYS" },
  "싱가포르": { m49: 702, iso3: "SGP" },
  "필리핀": { m49: 608, iso3: "PHL" },
  "미얀마": { m49: 104, iso3: "MMR" },
  "캄보디아": { m49: 116, iso3: "KHM" },
  "라오스": { m49: 418, iso3: "LAO" },
  "브루나이": { m49: 96, iso3: "BRN" },
  "인도": { m49: 356, iso3: "IND" },
  "호주": { m49: 36, iso3: "AUS" },
  "뉴질랜드": { m49: 554, iso3: "NZL" },
  "캐나다": { m49: 124, iso3: "CAN" },
  "독일": { m49: 276, iso3: "DEU" },
  "프랑스": { m49: 250, iso3: "FRA" },
  "영국": { m49: 826, iso3: "GBR" },
  "이탈리아": { m49: 380, iso3: "ITA" },
  "스페인": { m49: 724, iso3: "ESP" },
  "네덜란드": { m49: 528, iso3: "NLD" },
  "칠레": { m49: 152, iso3: "CHL" },
  "페루": { m49: 604, iso3: "PER" },
  "콜롬비아": { m49: 170, iso3: "COL" },
  "터키": { m49: 792, iso3: "TUR" },
  "튀르키예": { m49: 792, iso3: "TUR" },
  "이스라엘": { m49: 376, iso3: "ISR" }
};

// 위험국 정의 (proxy.py RISK_COUNTRY_TIER 동기화) — iso2: [name, tier, reason]
const RISK_COUNTRY_TIER = {
  "CN": ["중국", 1, "관세 회피·품목 위장·우회 최대 발원지"],
  "RU": ["러시아", 3, "국제 제재 회피"],
  "IR": ["이란", 3, "국제 제재 대상"],
  "KP": ["북한", 3, "국제 제재 대상"],
  "BY": ["벨라루스", 3, "제재 대상"],
  "MM": ["미얀마", 3, "제재·인권 이슈"],
  "VN": ["베트남", 2, "한-미·한-EU FTA 우회 정황 잦음"],
  "KH": ["캄보디아", 2, "섬유·의류 우회 정황"],
  "LA": ["라오스", 2, "농산물·목재 우회 정황"],
  "PK": ["파키스탄", 2, "섬유 우회 정황"],
  "BD": ["방글라데시", 2, "섬유 우회 정황"],
  "TR": ["튀르키예", 2, "러 관련 우회·섬유 위장 정황"]
};

// component_inflow 외국 생산국 케이스에서 쓰는 ISO3→ISO2 (proxy.py 로컬 서브셋)
const ISO3_TO_ISO2_SMALL = {
  CHN: "CN", RUS: "RU", IRN: "IR", PRK: "KP",
  BLR: "BY", MMR: "MM", VNM: "VN", KHM: "KH",
  LAO: "LA", PAK: "PK", BGD: "BD", TUR: "TR"
};

// origin_detect 후보 국가 (수입 실적 상위국 25개)
const MAJOR_ORIGINS = [
  ["CN", "중국"], ["VN", "베트남"], ["JP", "일본"], ["US", "미국"],
  ["IN", "인도"], ["TH", "태국"], ["ID", "인도네시아"], ["MY", "말레이시아"],
  ["DE", "독일"], ["IT", "이탈리아"], ["FR", "프랑스"], ["GB", "영국"],
  ["ES", "스페인"], ["RU", "러시아"],
  ["AU", "호주"], ["BR", "브라질"], ["CL", "칠레"], ["PE", "페루"],
  ["MX", "멕시코"], ["CA", "캐나다"], ["TW", "대만"], ["HK", "홍콩"],
  ["PH", "필리핀"], ["SG", "싱가포르"], ["BD", "방글라데시"]
];

// component_inflow (한국 생산 케이스) 스캔 대상 국가 (위험국 + 주요 조달국)
const SCAN_COUNTRIES = [
  ["CN", "중국"], ["RU", "러시아"], ["IR", "이란"], ["BY", "벨라루스"],
  ["MM", "미얀마"], ["VN", "베트남"], ["KH", "캄보디아"], ["LA", "라오스"],
  ["PK", "파키스탄"], ["BD", "방글라데시"], ["TR", "튀르키예"],
  ["JP", "일본"], ["US", "미국"], ["DE", "독일"], ["TW", "대만"],
  ["IN", "인도"], ["TH", "태국"], ["ID", "인도네시아"]
];

// FAO Area 코드 (M49와 다를 수 있음 — FAOSTAT 자체 코드)
const FAO_AREA_BY_ISO3 = {
  KOR: 117, CHN: 351, VNM: 237, JPN: 110, USA: 231,
  THA: 216, IDN: 101, MYS: 131, SGP: 200, PHL: 171,
  MMR: 28, KHM: 115, LAO: 120, BRN: 26,
  IND: 100, AUS: 10, NZL: 156, CAN: 33,
  DEU: 79, FRA: 68, GBR: 229, ITA: 106, ESP: 203,
  NLD: 150, CHL: 40, PER: 170, COL: 44, TUR: 223,
  ISR: 105, BRA: 21, ARG: 9, MEX: 138, EGY: 59,
  RUS: 185, PAK: 165, BGD: 16, LKA: 38, NPL: 149,
  PRT: 174, POL: 173, SWE: 210, DNK: 54, FIN: 67,
  GRC: 84, AUT: 11, BEL: 255, IRL: 104, CHE: 211,
  NOR: 162, ISL: 99, ZAF: 202
};


// ══════════════════════════════════════════════════════════
// [8] 캐시 헬퍼 (GAS ScriptCache 는 TTL 최대 21600초·값 최대 ~100KB)
// ══════════════════════════════════════════════════════════

function _cachePut(key, dataObj, ttlSeconds) {
  try {
    const s = JSON.stringify(dataObj);
    if (s.length > 95000) return; // 100KB 제한 근접 시 캐시 생략
    const ttl = Math.min(ttlSeconds || 21600, 21600);
    CacheService.getScriptCache().put(key, s, ttl);
  } catch (e) { /* 캐시 실패는 무시 (응답엔 영향 없음) */ }
}

function _cacheGet(key) {
  try {
    const v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}


// ══════════════════════════════════════════════════════════
// [9] 데이터 품목별 무역 흐름 (복합 조회) — /api/trade-flow
// ══════════════════════════════════════════════════════════

function tradeFlow(params) {
  params = params || {};
  const origin = params.origin || '';
  const transit = params.transit || '';
  const hs = params.hs || '';
  const year = params.year || '2024';

  if (!origin || !transit || !hs) return { error: 'origin, transit, hs 필수' };

  const originInfo = COUNTRY_ISO[origin];
  const transitInfo = COUNTRY_ISO[transit];
  if (!originInfo || !transitInfo) return { error: '지원하지 않는 국가' };
  if (!COMTRADE_KEY) return { error: 'Comtrade 키 미설정' };

  const cacheKey = 'flow_' + origin + '_' + transit + '_' + hs + '_' + year;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const tasks = [
    { key: 'origin_to_world',   reporter: originInfo.m49,  partner: 0 },
    { key: 'origin_to_transit', reporter: originInfo.m49,  partner: transitInfo.m49 },
    { key: 'transit_to_world',  reporter: transitInfo.m49, partner: 0 },
    { key: 'transit_to_korea',  reporter: transitInfo.m49, partner: 410 }
  ];

  const requests = tasks.map(function (t) {
    const url = 'https://comtradeapi.un.org/data/v1/get/C/A/HS' +
      '?freq=A&px=HS&ps=' + encodeURIComponent(year) +
      '&r=' + t.reporter + '&p=' + t.partner + '&rg=2&cc=' + encodeURIComponent(hs) +
      '&subscription-key=' + COMTRADE_KEY;
    return { url: url, muteHttpExceptions: true };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: 'Comtrade 병렬 호출 실패: ' + String(e) };
  }

  const resultsMap = {};
  for (let i = 0; i < tasks.length; i++) {
    try {
      resultsMap[tasks[i].key] = JSON.parse(responses[i].getContentText());
    } catch (e) {
      resultsMap[tasks[i].key] = { error: String(e) };
    }
  }

  const result = Object.assign({ origin: origin, transit: transit, hs: hs, year: year }, resultsMap);
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [10] 원산지 후보 자동 탐지 — /api/trade-origin
// ══════════════════════════════════════════════════════════

function tradeOrigin(params) {
  params = params || {};
  const transit = params.transit || '';
  const hs = params.hs || '';
  const year = params.year || '2023';
  const deepMode = params.deep === '1';

  if (!transit || !hs) return { error: 'transit, hs 필수' };
  if (!COMTRADE_KEY) return { error: 'Comtrade 키 미설정' };

  const transitInfo = COUNTRY_ISO[transit];
  if (!transitInfo) return { error: "'" + transit + "' 매핑 없음" };

  const cacheKey = 'origin-probe_' + transit + '_' + hs + '_' + year;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const hsClean = hs.trim();
  let hsOptions;
  if (hsClean.length >= 6) hsOptions = [hsClean.substring(0, 6), hsClean.substring(0, 4), hsClean.substring(0, 2)];
  else if (hsClean.length >= 4) hsOptions = [hsClean.substring(0, 4), hsClean.substring(0, 2)];
  else hsOptions = [hsClean];

  let yearOptions;
  const yearNum = parseInt(year, 10);
  if (deepMode) yearOptions = [year, String(yearNum - 1), String(yearNum - 2)];
  else yearOptions = [year, String(yearNum - 1)];

  const combos = [];
  hsOptions.forEach(function (h) { yearOptions.forEach(function (y) { combos.push([h, y]); }); });
  const attempts = combos.map(function (c) { return 'HS' + c[0] + '/' + c[1]; });

  const requests = combos.map(function (c) {
    const url = 'https://comtradeapi.un.org/data/v1/get/C/A/HS' +
      '?freq=A&px=HS&ps=' + encodeURIComponent(c[1]) +
      '&r=' + transitInfo.m49 + '&p=all&rg=1&cc=' + encodeURIComponent(c[0]) +
      '&subscription-key=' + COMTRADE_KEY;
    return { url: url, muteHttpExceptions: true };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: 'Comtrade 병렬 호출 실패: ' + String(e) };
  }

  const parallelResults = {};
  for (let i = 0; i < combos.length; i++) {
    const comboKey = combos[i][0] + '|' + combos[i][1];
    try {
      const status = responses[i].getResponseCode();
      if (status !== 200) { parallelResults[comboKey] = { byPartner: null, err: 'HTTP ' + status }; continue; }
      const data = JSON.parse(responses[i].getContentText());
      const rows = (data && data.data) || [];
      const byPartner = {};
      rows.forEach(function (row) {
        const partnerCode = row.partnerCode;
        const partnerName = row.partnerDesc;
        const partnerIso = row.partnerISO;
        if (!partnerName || partnerCode === 0) return;
        const val = row.primaryValue || row.cifvalue || row.fobvalue || 0;
        if (val <= 0) return;
        if (!byPartner[partnerName]) byPartner[partnerName] = { name: partnerName, iso: partnerIso, m49: partnerCode, value: 0 };
        byPartner[partnerName].value += val;
      });
      parallelResults[comboKey] = { byPartner: byPartner, err: null };
    } catch (e) {
      parallelResults[comboKey] = { byPartner: null, err: String(e) };
    }
  }

  let resultPartners = null, usedHs = null, usedYear = null;
  for (let i = 0; i < combos.length; i++) {
    const comboKey = combos[i][0] + '|' + combos[i][1];
    const entry = parallelResults[comboKey];
    if (entry && entry.byPartner && Object.keys(entry.byPartner).length > 0) {
      resultPartners = entry.byPartner;
      usedHs = combos[i][0]; usedYear = combos[i][1];
      break;
    }
    if (entry && entry.err) attempts[i] += ' (실패: ' + entry.err + ')';
  }

  if (!resultPartners) {
    return {
      error: '수출국의 해당 품목 수입 실적 없음',
      attempts: attempts,
      deep_mode_available: !deepMode,
      hint: "UN Comtrade에 '" + transit + "'이 HS " + hs + "를 수입한 기록 없음 (HS6/HS4/HS2 및 전년도까지 시도). " +
        (!deepMode ? '딥 모드(3년)로 더 넓게 시도할 수 있습니다.' : '다른 수출국 또는 다른 HS 범주로 시도해 보세요.')
    };
  }

  const allPartners = Object.keys(resultPartners).map(function (k) { return resultPartners[k]; });
  const topList = allPartners.slice().sort(function (a, b) { return b.value - a.value; }).slice(0, 10);
  const totalValue = allPartners.reduce(function (s, p) { return s + p.value; }, 0);
  topList.forEach(function (p) { p.share = totalValue > 0 ? Math.round((p.value / totalValue) * 10000) / 100 : 0; });

  const result = {
    transit: transit, hs: hs, year: year,
    used_hs: usedHs, used_year: usedYear,
    fallback_used: (usedHs !== hs || usedYear !== year),
    total_value: totalValue,
    total_partners: allPartners.length,
    top_origins: topList,
    attempts: attempts
  };
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [11] FAOSTAT 생산량 조회 — /api/faostat/production
// ══════════════════════════════════════════════════════════

function faostatProduction(params) {
  params = params || {};
  const iso3 = (params.country_iso3 || '').toUpperCase().trim();
  const itemCode = (params.item_code || '').trim();
  const domain = (params.domain || 'QCL').toUpperCase();
  const yearRange = params.year_range || '2020-2022';

  if (!iso3 || !itemCode) return { error: 'country_iso3, item_code 파라미터 필수' };

  const faoArea = FAO_AREA_BY_ISO3[iso3];
  if (!faoArea) return { error: 'FAOSTAT area 코드 매핑 없음: ' + iso3, supported_iso3: Object.keys(FAO_AREA_BY_ISO3) };

  const cacheKey = 'fao_' + iso3 + '_' + itemCode + '_' + domain + '_' + yearRange;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  let years;
  try {
    if (yearRange.indexOf('-') >= 0) {
      const parts = yearRange.split('-');
      const ys = parseInt(parts[0], 10), ye = parseInt(parts[1], 10);
      const arr = [];
      for (let y = ys; y <= ye; y++) arr.push(y);
      years = arr.join(',');
    } else {
      years = yearRange;
    }
  } catch (e) {
    years = '2020,2021,2022';
  }

  const url = 'https://fenixservices.fao.org/faostat/api/v1/en/data/' + domain +
    '?area=' + faoArea + '&item=' + encodeURIComponent(itemCode) + '&year=' + encodeURIComponent(years) +
    '&element=5510&show_codes=true&show_unit=true&show_flags=false&show_notes=false';

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      return { error: 'FAOSTAT API HTTP ' + response.getResponseCode(), iso3: iso3, item_code: itemCode };
    }
    let data;
    try { data = JSON.parse(response.getContentText()); }
    catch (e) { return { error: 'FAOSTAT 응답 JSON 파싱 실패 (서비스 점검 가능성)', raw_status: response.getResponseCode() }; }

    const rows = (data && data.data) || [];
    const timeseries = [];
    rows.forEach(function (row) {
      try {
        const yearV = parseInt(row.Year || row.year || 0, 10);
        const val = row.Value !== undefined ? row.Value : row.value;
        const unit = row.Unit || row.unit || 'tonnes';
        if (val === null || val === undefined) return;
        timeseries.push({ year: yearV, value: parseFloat(val), unit: unit });
      } catch (e) { /* skip */ }
    });
    timeseries.sort(function (a, b) { return a.year - b.year; });

    const latest = timeseries.length ? timeseries[timeseries.length - 1] : null;
    const avg3y = timeseries.length ? (timeseries.reduce(function (s, t) { return s + t.value; }, 0) / timeseries.length) : null;

    const result = {
      iso3: iso3,
      fao_area_code: faoArea,
      item_code: itemCode,
      domain: domain,
      year_range: yearRange,
      timeseries: timeseries,
      latest: latest,
      avg_3year_tonnes: avg3y ? Math.round(avg3y * 10) / 10 : null,
      raw_count: rows.length
    };
    _cachePut(cacheKey, result, 21600);
    return result;
  } catch (e) {
    return { error: 'FAOSTAT 호출 실패: ' + String(e) };
  }
}


// ══════════════════════════════════════════════════════════
// [12] FAOSTAT Detailed Trade Matrix — /api/faostat/trade-matrix
// ══════════════════════════════════════════════════════════

function faostatTradeMatrix(params) {
  params = params || {};
  const reporter = (params.reporter_iso3 || '').toUpperCase().trim();
  const partner = (params.partner_iso3 || '').toUpperCase().trim();
  const itemCode = (params.item_code || '').trim();
  const year = params.year || '2022';

  if (!reporter || !partner || !itemCode) return { error: 'reporter_iso3, partner_iso3, item_code 필수' };

  const repArea = FAO_AREA_BY_ISO3[reporter];
  const parArea = FAO_AREA_BY_ISO3[partner];
  if (!repArea || !parArea) return { error: 'FAO area 매핑 없음: reporter=' + reporter + ', partner=' + partner };

  const cacheKey = 'fao-tm_' + reporter + '_' + partner + '_' + itemCode + '_' + year;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  function buildUrl(element) {
    return 'https://fenixservices.fao.org/faostat/api/v1/en/data/TM' +
      '?area=' + repArea + '&partner_areas=' + parArea + '&item=' + encodeURIComponent(itemCode) +
      '&year=' + encodeURIComponent(year) + '&element=' + element + '&show_codes=true&show_unit=true';
  }

  function parseElementResponse(resp) {
    try {
      if (resp.getResponseCode() !== 200) return null;
      const data = JSON.parse(resp.getContentText());
      const rows = (data && data.data) || [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i].Value;
        if (v === null || v === undefined) continue;
        return { value: parseFloat(v), unit: rows[i].Unit || 'tonnes', year: rows[i].Year };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  let responses;
  try {
    responses = UrlFetchApp.fetchAll([
      { url: buildUrl('5610'), muteHttpExceptions: true },
      { url: buildUrl('5910'), muteHttpExceptions: true }
    ]);
  } catch (e) {
    return { error: 'FAOSTAT TM 병렬 호출 실패: ' + String(e) };
  }

  const importResult = parseElementResponse(responses[0]);
  const exportResult = parseElementResponse(responses[1]);

  if (importResult === null && exportResult === null) {
    return {
      error: 'FAOSTAT TM에 해당 무역 흐름 데이터 없음 (당해년도 거래 없거나 비등록)',
      reporter: reporter, partner: partner, item_code: itemCode, year: year
    };
  }

  const payload = {
    reporter: reporter,
    partner: partner,
    item_code: itemCode,
    year: year,
    import_from_partner: importResult,
    export_to_partner: exportResult
  };
  _cachePut(cacheKey, payload, 21600);
  return payload;
}


// ══════════════════════════════════════════════════════════
// [13] OECD TiVA — 부가가치 벤치마크 — /api/oecd-tiva
// ══════════════════════════════════════════════════════════

function oecdTiva(params) {
  params = params || {};
  const iso3 = (params.country_iso3 || '').toUpperCase().trim();
  const sector = (params.sector || '').trim();
  const year = params.year || '2020';

  if (!iso3 || !sector) return { error: 'country_iso3, sector 파라미터 필수' };

  const cacheKey = 'tiva_' + iso3 + '_' + sector + '_' + year;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const indicators = {
    dvash: 'EXGR_DVASH',
    fvash: 'EXGR_FVASH',
    bwfva: 'BWFVA',
    fwdva: 'DEXFVAPSH'
  };
  const indicatorKeys = Object.keys(indicators);

  function urlsFor(indicatorCode) {
    return [
      'https://sdmx.oecd.org/public/rest/data/OECD.STI.PIE,DSD_TIVA@DF_TIVA,1.0/' + iso3 + '.A.' + indicatorCode + '.' + sector +
        '._T.._T?startPeriod=' + year + '&endPeriod=' + year + '&dimensionAtObservation=AllDimensions&format=jsondata',
      'https://stats.oecd.org/sdmx-json/data/TIVA_2021_C1/' + iso3 + '.' + indicatorCode + '.' + sector +
        '/all?startTime=' + year + '&endTime=' + year
    ];
  }

  function extractValue(data) {
    try {
      const ds = data.dataSets || [];
      if (ds.length) {
        const series = ds[0].series || {};
        const seriesKeys = Object.keys(series);
        for (let i = 0; i < seriesKeys.length; i++) {
          const obs = series[seriesKeys[i]].observations || {};
          const obsKeys = Object.keys(obs);
          for (let j = 0; j < obsKeys.length; j++) {
            const v = obs[obsKeys[j]];
            if (Array.isArray(v) && v.length) return parseFloat(v[0]);
          }
        }
      }
      if (data.observations) {
        const keys = Object.keys(data.observations);
        for (let i = 0; i < keys.length; i++) {
          const v = data.observations[keys[i]];
          if (Array.isArray(v) && v.length) return parseFloat(v[0]);
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 4개 지표 × 2개 fallback URL = 최대 8개 요청을 한 번에 병렬 호출
  const requestMeta = [];
  const requests = [];
  indicatorKeys.forEach(function (key) {
    urlsFor(indicators[key]).forEach(function (u) {
      requestMeta.push(key);
      requests.push({ url: u, muteHttpExceptions: true, headers: { Accept: 'application/json' } });
    });
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: 'OECD TiVA 병렬 호출 실패: ' + String(e) };
  }

  const results = {};
  indicatorKeys.forEach(function (key) { results[key] = null; });
  for (let i = 0; i < requestMeta.length; i++) {
    const key = requestMeta[i];
    if (results[key] !== null) continue; // 이미 값 찾음 (첫 URL 성공)
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) continue;
      const data = JSON.parse(resp.getContentText());
      const v = extractValue(data);
      if (v !== null) results[key] = v;
    } catch (e) { /* try next */ }
  }

  const dvash = results.dvash;
  const assessment = { benchmark: null, interpretation: '' };
  if (dvash !== null && dvash !== undefined) {
    assessment.benchmark = dvash;
    if (dvash >= 70) assessment.interpretation = 'DVA ' + dvash.toFixed(1) + '% — 국내 부가가치 매우 높음 (자체 가공 위주, 수입중간재 의존도 낮음)';
    else if (dvash >= 50) assessment.interpretation = 'DVA ' + dvash.toFixed(1) + '% — 국내 부가가치 평균 이상 (정상적인 자체 생산)';
    else if (dvash >= 30) assessment.interpretation = 'DVA ' + dvash.toFixed(1) + '% — 국내 부가가치 평균 이하 (수입중간재 비중 큼)';
    else assessment.interpretation = 'DVA ' + dvash.toFixed(1) + '% — 국내 부가가치 매우 낮음 (대부분 외국산 중간재 사용 — 가공무역·환적 의심)';
  }

  const allNull = indicatorKeys.every(function (k) { return results[k] === null; });
  if (allNull) {
    return { iso3: iso3, sector: sector, year: year, error: 'OECD TiVA에 해당 조합 데이터 없음 (비OECD 국가 또는 산업코드 미제공)', indicators: results };
  }

  const payload = { iso3: iso3, sector: sector, year: year, indicators: results, assessment: assessment };
  _cachePut(cacheKey, payload, 21600);
  return payload;
}


// ══════════════════════════════════════════════════════════
// [14] 산업 프로파일 조회 — /api/industry-profile
// ══════════════════════════════════════════════════════════

function industryProfile(params) {
  params = params || {};
  const country = (params.country || '').trim();
  const sector = (params.sector || '').trim();
  const years = params.years || '2020:2024';

  if (!country) return { error: 'country 파라미터 필수' };

  const cacheKey = 'industry_' + country + '_' + sector + '_' + years;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const indicatorMap = {
    manufacturing_va_usd: 'NV.IND.MANF.CD',
    manufacturing_va_pct: 'NV.IND.MANF.ZS',
    manufacturing_growth: 'NV.IND.MANF.KD.ZG',
    industry_va_usd: 'NV.IND.TOTL.CD',
    industry_va_pct: 'NV.IND.TOTL.ZS',
    gdp_total: 'NY.GDP.MKTP.CD',
    trade_pct_gdp: 'NE.TRD.GNFS.ZS',
    fdi_inflow: 'BX.KLT.DINV.CD.WD'
  };
  const indicatorKeys = Object.keys(indicatorMap);

  const requests = indicatorKeys.map(function (key) {
    const url = 'https://api.worldbank.org/v2/country/' + country + '/indicator/' + indicatorMap[key] +
      '?format=json&date=' + encodeURIComponent(years) + '&per_page=30';
    return { url: url, muteHttpExceptions: true };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: 'World Bank 병렬 호출 실패: ' + String(e) };
  }

  const results = {};
  for (let i = 0; i < indicatorKeys.length; i++) {
    const key = indicatorKeys[i];
    results[key] = null;
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) continue;
      const data = JSON.parse(resp.getContentText());
      if (!Array.isArray(data) || data.length < 2 || !data[1]) continue;
      const series = [];
      let latestValue = null, latestYear = null;
      data[1].forEach(function (row) {
        const v = row.value;
        const y = row.date;
        if (v !== null && v !== undefined) {
          series.push({ year: y, value: v });
          if (latestValue === null) { latestValue = v; latestYear = y; }
        }
      });
      results[key] = { latest: latestValue, latest_year: latestYear, series: series };
    } catch (e) { /* leave null */ }
  }

  const mfgPct = results.manufacturing_va_pct || {};
  const assessment = { strength: 'unknown', note: '' };
  if (mfgPct.latest !== null && mfgPct.latest !== undefined) {
    const pct = mfgPct.latest;
    if (pct >= 25) { assessment.strength = 'very_high'; assessment.note = '제조업이 GDP의 ' + pct.toFixed(1) + '%로 매우 강함 (제조 강국)'; }
    else if (pct >= 15) { assessment.strength = 'high'; assessment.note = '제조업이 GDP의 ' + pct.toFixed(1) + '%로 강한 편'; }
    else if (pct >= 10) { assessment.strength = 'medium'; assessment.note = '제조업이 GDP의 ' + pct.toFixed(1) + '%로 평균 수준'; }
    else if (pct >= 5) { assessment.strength = 'low'; assessment.note = '제조업이 GDP의 ' + pct.toFixed(1) + '%로 낮음'; }
    else { assessment.strength = 'very_low'; assessment.note = '제조업이 GDP의 ' + pct.toFixed(1) + '%로 매우 낮음 — 우회 가능성 ↑'; }
  }

  const payload = { country: country, sector: sector, indicators: results, assessment: assessment };
  _cachePut(cacheKey, payload, 21600);
  return payload;
}


// ══════════════════════════════════════════════════════════
// [15] 관세청 공공데이터포털(data.go.kr) 품목별국가별수출입실적
//      nitemtrade API — XML 응답 파싱 헬퍼
// ══════════════════════════════════════════════════════════

const NITEMTRADE_URL = 'http://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList';

// XmlService 로 관세청 XML 응답 파싱 → { resultCode, resultMsg, items: [...] }
function _parseNitemtradeXml(xmlText) {
  try {
    const doc = XmlService.parse(xmlText);
    const root = doc.getRootElement();
    const header = root.getChild('header');
    const resultCode = header ? (header.getChildText('resultCode') || '') : '';
    const resultMsg = header ? (header.getChildText('resultMsg') || '') : '';
    const items = [];
    const body = root.getChild('body');
    if (body) {
      const itemsNode = body.getChild('items');
      if (itemsNode) {
        const itemNodes = itemsNode.getChildren('item');
        for (let i = 0; i < itemNodes.length; i++) {
          const children = itemNodes[i].getChildren();
          const obj = {};
          for (let j = 0; j < children.length; j++) {
            obj[children[j].getName()] = (children[j].getText() || '').trim();
          }
          items.push(obj);
        }
      }
    }
    return { resultCode: resultCode, resultMsg: resultMsg, items: items, error: null };
  } catch (e) {
    return { resultCode: null, resultMsg: null, items: [], error: String(e) };
  }
}

function _toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}


// ══════════════════════════════════════════════════════════
// [16] 관세청 데이터 기반 원산지 자동탐지 — /api/customs/origin-detect
// ══════════════════════════════════════════════════════════

function originDetect(params) {
  params = params || {};
  const hs = (params.hs || '').trim();
  const transit = (params.transit || '').trim();
  let months = parseInt(params.months || '12', 10);
  if (months > 12) months = 12;

  if (!hs) return { error: 'hs 파라미터 필수' };
  const queryHs = hs.length > 6 ? hs.substring(0, 6) : hs;

  // 조회 기간: 최근 N개월 (관세청은 매월 15일 업데이트 → 안전하게 2개월 전을 기준)
  const now = new Date();
  let endYr = now.getFullYear(), endMm = now.getMonth() + 1 - 2;
  if (endMm <= 0) { endYr -= 1; endMm += 12; }
  let startMm = endMm - months + 1, startYr = endYr;
  while (startMm <= 0) { startYr -= 1; startMm += 12; }
  const start = '' + startYr + ('' + startMm).padStart(2, '0');
  const end = '' + endYr + ('' + endMm).padStart(2, '0');

  const cacheKey = 'customs_origin_' + queryHs + '_' + start + '_' + end;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true, hs: hs, transit: transit }, cached);

  if (!DATA_GO_KR_KEY) return { error: '관세청 API 키 미설정' };

  const requests = MAJOR_ORIGINS.map(function (pair) {
    const url = NITEMTRADE_URL + '?serviceKey=' + DATA_GO_KR_KEY +
      '&strtYymm=' + start + '&endYymm=' + end + '&cntyCd=' + pair[0] + '&hsSgn=' + encodeURIComponent(queryHs);
    return { url: url, muteHttpExceptions: true };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: '관세청 API 병렬 호출 실패: ' + String(e) };
  }

  const results = [];
  for (let i = 0; i < MAJOR_ORIGINS.length; i++) {
    const iso2 = MAJOR_ORIGINS[i][0], name = MAJOR_ORIGINS[i][1];
    try {
      if (responses[i].getResponseCode() !== 200) continue;
      const parsed = _parseNitemtradeXml(responses[i].getContentText());
      if (parsed.error) continue;
      let totalImpDlr = 0, totalImpWgt = 0;
      parsed.items.forEach(function (item) {
        if ((item.year || '').trim() === '총계') return;
        totalImpDlr += _toNumber(item.impDlr);
        totalImpWgt += _toNumber(item.impWgt);
      });
      if (totalImpDlr > 0) results.push({ iso: iso2, name: name, imp_dlr: totalImpDlr, imp_wgt_kg: totalImpWgt });
    } catch (e) { /* skip country on error */ }
  }

  results.sort(function (a, b) { return b.imp_dlr - a.imp_dlr; });
  const totalAll = results.reduce(function (s, r) { return s + r.imp_dlr; }, 0);

  const top = results.slice(0, 5).map(function (r) {
    return {
      iso: r.iso, name: r.name,
      share: totalAll > 0 ? Math.round((r.imp_dlr / totalAll) * 10000) / 100 : 0,
      imp_dlr: r.imp_dlr, imp_wgt_kg: r.imp_wgt_kg
    };
  });

  const result = {
    hs: hs, used_hs: queryHs, transit: transit,
    period: { from: start, to: end },
    top_origins: top,
    total_countries_checked: MAJOR_ORIGINS.length,
    total_countries_with_import: results.length,
    source: '관세청 (공공데이터포털)'
  };
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [17] BOM 부품 유입 정황 조사 — /api/component-inflow
// ══════════════════════════════════════════════════════════

function componentInflow(params) {
  params = params || {};
  const producer = (params.producer || '').trim();
  const hs = (params.hs || '').trim();
  let months = parseInt(params.months || '12', 10);
  if (months > 12) months = 12;

  if (!producer || !hs) return { error: 'producer, hs 파라미터 필수' };
  const queryHs = hs.length > 6 ? hs.substring(0, 6) : hs;

  const cacheKey = 'comp_inflow_' + producer + '_' + queryHs + '_' + months;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  let topSources = [];
  let sourceLabel = '';
  let periodStr = '';

  const isKorea = (producer === '한국' || producer === '대한민국' || producer === 'Korea' || producer === 'KR');

  if (isKorea) {
    sourceLabel = '관세청 (공공데이터포털)';
    if (!DATA_GO_KR_KEY) return { error: '관세청 API 키 미설정' };

    const now = new Date();
    let endYr = now.getFullYear(), endMm = now.getMonth() + 1 - 2;
    if (endMm <= 0) { endYr -= 1; endMm += 12; }
    let startMm = endMm - months + 1, startYr = endYr;
    while (startMm <= 0) { startYr -= 1; startMm += 12; }
    const start = '' + startYr + ('' + startMm).padStart(2, '0');
    const end = '' + endYr + ('' + endMm).padStart(2, '0');

    const requests = SCAN_COUNTRIES.map(function (pair) {
      const url = NITEMTRADE_URL + '?serviceKey=' + DATA_GO_KR_KEY +
        '&strtYymm=' + start + '&endYymm=' + end + '&cntyCd=' + pair[0] + '&hsSgn=' + encodeURIComponent(queryHs);
      return { url: url, muteHttpExceptions: true };
    });

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      return { error: '관세청 API 병렬 호출 실패: ' + String(e) };
    }

    const results = [];
    for (let i = 0; i < SCAN_COUNTRIES.length; i++) {
      const iso2 = SCAN_COUNTRIES[i][0], name = SCAN_COUNTRIES[i][1];
      try {
        if (responses[i].getResponseCode() !== 200) continue;
        const parsed = _parseNitemtradeXml(responses[i].getContentText());
        if (parsed.error) continue;
        let totalDlr = 0;
        parsed.items.forEach(function (item) {
          if ((item.year || '').trim() === '총계') return;
          totalDlr += _toNumber(item.impDlr);
        });
        if (totalDlr > 0) results.push({ iso2: iso2, name: name, dlr: totalDlr });
      } catch (e) { /* skip */ }
    }

    results.sort(function (a, b) { return b.dlr - a.dlr; });
    const total = results.reduce(function (s, r) { return s + r.dlr; }, 0);
    results.slice(0, 8).forEach(function (r) {
      const risk = RISK_COUNTRY_TIER[r.iso2];
      topSources.push({
        iso2: r.iso2, name: r.name, dlr: r.dlr,
        share: total > 0 ? Math.round((r.dlr / total) * 10000) / 100 : 0,
        risk_tier: risk ? risk[1] : 0,
        risk_reason: risk ? risk[2] : ''
      });
    });
    periodStr = start + ' ~ ' + end;

  } else {
    const producerInfo = COUNTRY_ISO[producer];
    if (!producerInfo) return { error: "'" + producer + "' 생산국 매핑 없음. Comtrade 조회 불가." };
    if (!COMTRADE_KEY) return { error: 'Comtrade API 키 미설정 (외국 생산국 조회 필요)' };

    sourceLabel = 'UN Comtrade';
    const year = String(new Date().getFullYear() - 1);
    const url = 'https://comtradeapi.un.org/data/v1/get/C/A/HS' +
      '?freq=A&px=HS&ps=' + year + '&r=' + producerInfo.m49 + '&p=all&rg=1&cc=' + encodeURIComponent(queryHs) +
      '&subscription-key=' + COMTRADE_KEY;

    let response;
    try {
      response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    } catch (e) {
      return { error: 'Comtrade 호출 실패: ' + String(e) };
    }
    if (response.getResponseCode() !== 200) {
      return { error: 'Comtrade 응답 ' + response.getResponseCode(), hint: response.getContentText().substring(0, 300) };
    }
    let data;
    try { data = JSON.parse(response.getContentText()); }
    catch (e) { return { error: 'Comtrade 응답 파싱 실패: ' + String(e) }; }
    const rows = (data && data.data) || [];

    const byPartner = {};
    rows.forEach(function (row) {
      const partnerIso = row.partnerISO || '';
      const partnerName = row.partnerDesc || partnerIso;
      const val = row.primaryValue || 0;
      if (['W00', '_X', 'R4'].indexOf(partnerIso) >= 0) return;
      if (!partnerIso || partnerIso.indexOf('_') === 0) return;
      if (!byPartner[partnerIso]) byPartner[partnerIso] = { name: partnerName, iso3: partnerIso, dlr: 0 };
      byPartner[partnerIso].dlr += val;
    });

    const results = Object.keys(byPartner).map(function (k) { return byPartner[k]; }).sort(function (a, b) { return b.dlr - a.dlr; });
    const total = results.reduce(function (s, r) { return s + r.dlr; }, 0);

    results.slice(0, 8).forEach(function (r) {
      const iso2 = ISO3_TO_ISO2_SMALL[r.iso3];
      const risk = iso2 ? RISK_COUNTRY_TIER[iso2] : null;
      topSources.push({
        iso3: r.iso3, iso2: iso2 || '', name: r.name, dlr: r.dlr,
        share: total > 0 ? Math.round((r.dlr / total) * 10000) / 100 : 0,
        risk_tier: risk ? risk[1] : 0,
        risk_reason: risk ? risk[2] : ''
      });
    });
    periodStr = year;
  }

  const riskyShare = topSources.filter(function (s) { return s.risk_tier > 0; }).reduce(function (s, x) { return s + x.share; }, 0);
  const tier1Share = topSources.filter(function (s) { return s.risk_tier === 1; }).reduce(function (s, x) { return s + x.share; }, 0);
  const tier3Share = topSources.filter(function (s) { return s.risk_tier === 3; }).reduce(function (s, x) { return s + x.share; }, 0);

  let riskVerdict, riskMessage;
  if (tier3Share >= 30) { riskVerdict = 'critical'; riskMessage = '제재 대상국(tier 3) 비중 ' + tier3Share.toFixed(1) + '% — 심각한 위장 정황'; }
  else if (tier1Share >= 60) { riskVerdict = 'high'; riskMessage = '중국 비중 ' + tier1Share.toFixed(1) + '% — 원산지 위장 유력 정황'; }
  else if (riskyShare >= 50) { riskVerdict = 'high'; riskMessage = '위험국 총 비중 ' + riskyShare.toFixed(1) + '% — 위장 정황'; }
  else if (riskyShare >= 25) { riskVerdict = 'medium'; riskMessage = '위험국 총 비중 ' + riskyShare.toFixed(1) + '% — 주의 필요'; }
  else if (topSources.length) { riskVerdict = 'low'; riskMessage = '위험국 비중 ' + riskyShare.toFixed(1) + '% — 유입 정황 낮음'; }
  else { riskVerdict = 'no_data'; riskMessage = '수입 실적이 조회되지 않음'; }

  const result = {
    producer: producer, hs: hs, used_hs: queryHs, source: sourceLabel, period: periodStr,
    top_sources: topSources,
    total_dlr: topSources.reduce(function (s, x) { return s + x.dlr; }, 0),
    risky_share: Math.round(riskyShare * 100) / 100,
    tier1_share: Math.round(tier1Share * 100) / 100,
    tier3_share: Math.round(tier3Share * 100) / 100,
    risk_verdict: riskVerdict, risk_message: riskMessage
  };
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [18] 관세청 품목별 국가별 수출입실적 — /api/customs/trade-stat
// ══════════════════════════════════════════════════════════

function customsTradeStat(params) {
  params = params || {};
  const hs = (params.hs || '').trim();
  const country = (params.country || '').trim().toUpperCase();
  const start = (params.from || '').trim();
  const end = (params.to || '').trim();

  if (!country || country.length !== 2) return { error: 'country 파라미터 필수 (2자리 국가코드, 예: CN, VN, US)' };
  if (!start || !end || start.length !== 6 || end.length !== 6) return { error: 'from·to 파라미터 필수 (YYYYMM 6자리, 예: 202301)' };
  if (!DATA_GO_KR_KEY) return { error: '공공데이터포털 API 키 미설정 (DATA_GO_KR_KEY 스크립트 속성)' };

  const cacheKey = 'customs_trade_' + hs + '_' + country + '_' + start + '_' + end;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const originalHs = hs;
  const queryHs = (hs && hs.length > 6) ? hs.substring(0, 6) : hs;

  let url = NITEMTRADE_URL + '?serviceKey=' + DATA_GO_KR_KEY + '&strtYymm=' + start + '&endYymm=' + end + '&cntyCd=' + country;
  if (queryHs) url += '&hsSgn=' + encodeURIComponent(queryHs);

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (e) {
    return { error: '관세청 API 호출 실패: ' + String(e) };
  }
  if (response.getResponseCode() !== 200) {
    return { error: '관세청 API HTTP ' + response.getResponseCode(), raw: response.getContentText().substring(0, 500) };
  }

  const parsed = _parseNitemtradeXml(response.getContentText());
  if (parsed.error) return { error: 'XML 파싱 실패: ' + parsed.error, raw: response.getContentText().substring(0, 800) };

  if (parsed.resultCode !== '00') {
    let hint = '';
    if (parsed.resultCode === '30') hint = ' (인증키가 잘못됐거나 활용신청 승인 대기)';
    else if (parsed.resultCode === '22') hint = ' (요청 한도 초과 - 10,000/일)';
    else if (parsed.resultCode === '31' || parsed.resultCode === '32') hint = ' (활용신청 필요)';
    return {
      error: '관세청 API 오류: ' + parsed.resultCode + ' - ' + parsed.resultMsg + hint,
      hint: 'https://www.data.go.kr/data/15100475/openapi.do 에서 활용신청 후 승인 대기 or 인증키 재확인'
    };
  }

  // 숫자 필드 변환
  const numFields = ['expWgt', 'expDlr', 'impWgt', 'impDlr', 'balPayments'];
  const items = parsed.items.map(function (it) {
    const copy = Object.assign({}, it);
    numFields.forEach(function (f) {
      if (copy[f] !== undefined && copy[f] !== '') copy[f] = _toNumber(copy[f]);
    });
    return copy;
  });

  const totalItems = items.filter(function (it) { return String(it.year || '').trim() === '총계'; });
  const detailItems = items.filter(function (it) { return String(it.year || '').trim() !== '총계'; });

  let itemsMatched = [];
  if (originalHs && originalHs.length > 6) {
    itemsMatched = detailItems.filter(function (it) {
      const itemHs = String(it.hsCd || '').replace(/\./g, '').trim();
      return itemHs === originalHs || (itemHs.length >= originalHs.length && itemHs.indexOf(originalHs) === 0);
    });
  }

  const hsBreakdown = {};
  detailItems.forEach(function (it) {
    const hsCode = String(it.hsCd || '').trim();
    if (!hsCode || hsCode === '-') return;
    if (!hsBreakdown[hsCode]) {
      hsBreakdown[hsCode] = { hsCd: hsCode, name: it.statKor || '', imp_dlr: 0, imp_wgt_kg: 0, exp_dlr: 0, exp_wgt_kg: 0, months: 0 };
    }
    const b = hsBreakdown[hsCode];
    b.imp_dlr += (typeof it.impDlr === 'number') ? it.impDlr : 0;
    b.imp_wgt_kg += (typeof it.impWgt === 'number') ? it.impWgt : 0;
    b.exp_dlr += (typeof it.expDlr === 'number') ? it.expDlr : 0;
    b.exp_wgt_kg += (typeof it.expWgt === 'number') ? it.expWgt : 0;
    b.months += 1;
  });
  const hsBreakdownList = Object.keys(hsBreakdown).map(function (k) { return hsBreakdown[k]; }).sort(function (a, b) { return b.imp_dlr - a.imp_dlr; });

  const summaryItems = itemsMatched.length ? itemsMatched : detailItems;
  const totalImpDlr = summaryItems.reduce(function (s, i) { return s + ((typeof i.impDlr === 'number') ? i.impDlr : 0); }, 0);
  const totalImpWgt = summaryItems.reduce(function (s, i) { return s + ((typeof i.impWgt === 'number') ? i.impWgt : 0); }, 0);
  const totalExpDlr = summaryItems.reduce(function (s, i) { return s + ((typeof i.expDlr === 'number') ? i.expDlr : 0); }, 0);
  const totalExpWgt = summaryItems.reduce(function (s, i) { return s + ((typeof i.expWgt === 'number') ? i.expWgt : 0); }, 0);

  let basis;
  if (itemsMatched.length) basis = '10자리 매칭 (' + originalHs + ')';
  else if (queryHs) basis = '6자리 종합 (' + queryHs + ' 하위 ' + hsBreakdownList.length + '개 세부)';
  else basis = '전체';

  let note = null;
  if (originalHs && originalHs.length > 6 && !itemsMatched.length) {
    note = '요청 HS ' + originalHs + '가 관세청 응답에 없음. 대신 6자리 ' + queryHs + ' 하위 ' + hsBreakdownList.length + '개 세부 코드 데이터 반환 (hs_breakdown 참조)';
  } else if (originalHs && originalHs.length > 6) {
    note = 'HS 6자리로 축소 조회 (관세청 API 제약). items_matched에 10자리 매칭 결과 포함';
  }

  const result = {
    hs_requested: originalHs,
    hs_queried: queryHs,
    hs_downgraded: !!(originalHs && queryHs && originalHs !== queryHs),
    country: country, from: start, to: end,
    count: items.length,
    count_detail: detailItems.length,
    count_matched: itemsMatched.length,
    summary: {
      total_imp_dlr: totalImpDlr, total_imp_wgt_kg: totalImpWgt,
      total_exp_dlr: totalExpDlr, total_exp_wgt_kg: totalExpWgt,
      avg_unit_price_imp: totalImpWgt > 0 ? (totalImpDlr / totalImpWgt) : null,
      basis: basis
    },
    hs_breakdown: hsBreakdownList,
    hs_matched_missing: !!(originalHs && originalHs.length > 6 && !itemsMatched.length),
    items: items,
    items_detail: detailItems,
    items_matched: itemsMatched,
    items_total_row: totalItems,
    source: '관세청 (공공데이터포털)',
    note: note
  };
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [19] Gemini 공용 헬퍼 — system_instruction·JSON 모드 지원
//      proxy.py _gemini_generate() 포팅
// ══════════════════════════════════════════════════════════

// 반환: { result: {text, model, truncated, finish_reason, tokens, _cached?} | null, error: string | null }
function geminiGenerate(systemInstr, prompt, cacheKey, temperature, maxTokens, responseMimeType) {
  if (temperature === undefined || temperature === null) temperature = 0.3;
  if (!maxTokens) maxTokens = 8192;

  if (!GEMINI_KEY) return { result: null, error: 'Gemini API 키 미설정 (GEMINI_KEY 스크립트 속성)' };

  if (cacheKey) {
    const cached = _cacheGet(cacheKey);
    if (cached) {
      const withCacheFlag = Object.assign({}, cached, { _cached: true });
      return { result: withCacheFlag, error: null };
    }
  }

  const genConfig = {
    temperature: temperature,
    maxOutputTokens: maxTokens,
    topP: 0.95,
    thinkingConfig: { thinkingBudget: 0 }
  };
  if (responseMimeType) genConfig.responseMimeType = responseMimeType;

  const payload = {
    system_instruction: { parts: [{ text: systemInstr }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: genConfig
  };

  // 컴팩트 fallback 체인 (proxy.py와 동일한 후보군)
  const modelCandidates = [GEMINI_MODEL];
  ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'].forEach(function (fm) {
    if (modelCandidates.indexOf(fm) < 0) modelCandidates.push(fm);
  });

  let lastError = null, data = null, usedModel = null;

  for (let i = 0; i < modelCandidates.length; i++) {
    const model = modelCandidates[i];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + GEMINI_KEY;
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const status = response.getResponseCode();
      const respBody = response.getContentText();
      if (status === 200) {
        data = JSON.parse(respBody);
        usedModel = model;
        break;
      } else if (status === 429 || status === 503 || status === 500) {
        lastError = 'HTTP ' + status + ' (' + model + ')';
        Utilities.sleep(1000);
        continue;
      } else if (status === 404) {
        lastError = 'HTTP 404 (' + model + '): ' + respBody.substring(0, 200);
        continue;
      } else {
        lastError = 'HTTP ' + status + ' (' + model + '): ' + respBody.substring(0, 200);
        continue;
      }
    } catch (err) {
      lastError = String(err) + ' (' + model + ')';
      continue;
    }
  }

  if (!data) {
    return { result: null, error: 'Gemini 호출 실패 (모든 모델 시도): ' + lastError };
  }

  try {
    const candidates = data.candidates || [];
    if (!candidates.length) return { result: null, error: 'Gemini 응답 비어있음' };
    const c0 = candidates[0];
    const parts = (c0.content && c0.content.parts) || [];
    const text = parts.map(function (p) { return p.text || ''; }).join(' ').trim();
    if (!text) {
      const fr = c0.finishReason || '';
      return { result: null, error: 'Gemini 텍스트 없음 (finishReason=' + fr + ')' };
    }
    const finishReason = c0.finishReason || 'STOP';
    const truncated = (finishReason === 'MAX_TOKENS');
    const usage = data.usageMetadata || {};
    const result = {
      text: text,
      model: usedModel,
      truncated: truncated,
      finish_reason: finishReason,
      tokens: {
        prompt: usage.promptTokenCount || 0,
        response: usage.candidatesTokenCount || 0,
        total: usage.totalTokenCount || 0
      }
    };
    if (cacheKey) _cachePut(cacheKey, result, 21600);
    return { result: result, error: null };
  } catch (e) {
    return { result: null, error: '응답 파싱 오류: ' + String(e) };
  }
}

// proxy.py _robust_json_parse() 포팅 — Gemini의 JSON 응답을 견고하게 파싱
function robustJsonParse(text) {
  if (!text) return null;
  // 시도 1: 원본 그대로
  try { return JSON.parse(text); } catch (e) { /* continue */ }
  // 시도 2: markdown code fence 제거 (앞/뒤, 여러 줄 지원)
  const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
  try { return JSON.parse(stripped); } catch (e) { /* continue */ }
  // 시도 3: 첫 { 부터 마지막 } 사이만 추출
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const snippet = stripped.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(snippet); } catch (e) { /* continue */ }
    // 시도 4: 흔한 오류 정정 (스마트 따옴표, trailing comma)
    let fixed = snippet
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch (e) { /* give up */ }
  }
  return null;
}


// ══════════════════════════════════════════════════════════
// [20] BOM 부품 AI 추천 — /api/gemini/bom-suggest
// ══════════════════════════════════════════════════════════

function bomSuggest(body) {
  body = body || {};
  const hs = String(body.hs || '').trim();
  const name = String(body.name || '').trim();
  const origin = String(body.origin || '').trim();
  const fta = String(body.fta || '').trim();

  if (!hs || hs.length < 6) return { error: 'HS 코드 6자리 이상 필요' };

  const cacheKey = 'bom-sug_' + Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, hs + '|' + name + '|' + origin + '|' + fta
  )).replace(/[^a-zA-Z0-9]/g, '');

  const systemInstr =
    '당신은 한국 관세청 원산지 검증 전문가이자 제조 산업 도메인 전문가입니다. ' +
    'HS 코드와 품명을 보고 이 제품에 일반적으로 사용되는 표준 BOM(Bill of Materials)을 ' +
    '실제 제조 관행에 기반해 도출하며, 원산지 위반 위험이 있는 부품을 특정할 수 있습니다.';

  const prompt = '다음 완제품의 표준 BOM(원재료 명세)을 추정하여 JSON으로 응답하세요.\n\n' +
    '【완제품 정보】\n' +
    '- HS 코드: ' + hs + '\n' +
    '- 품명: ' + (name || '(미입력 — HS로 추정)') + '\n' +
    '- 완제품 생산국(주장 원산지): ' + (origin || '(미지정)') + '\n' +
    '- 적용 FTA: ' + (fta || '(미지정)') + '\n\n' +
    '【지시】\n' +
    '1. 이 제품을 만드는 데 실제로 필요한 주요 부품·원료를 5~10개 도출.\n' +
    '2. 부품마다 HS 6자리, 전형적 원가 비중(%), 중요도(핵심/주요/보조), 통상 조달 국가, 원산지 위장 위험도.\n' +
    '3. 완제품 생산국(' + (origin || 'N/A') + ')의 산업 여건상 이 부품을 자체 생산하기 어려워 특정 국가에서 대량 수입하는 부품이 있으면 특히 표시.\n' +
    '4. 농산물·1차산품·단일 원료 제품이면 components를 빈 배열로 두고 notes에 이유 설명.\n\n' +
    '【응답 형식 — 반드시 유효한 JSON 하나만, 다른 텍스트 금지】\n' +
    '{\n' +
    '  "product_summary": "이 제품이 무엇이고 어떻게 만들어지는지 1~2문장",\n' +
    '  "estimated_fob_range_usd": {"min": 숫자, "max": 숫자},\n' +
    '  "manufacturing_note": "완제품 생산국에서 실제로 이 제품을 만들 수 있는가? 어떤 부품을 수입에 의존하는가? (1~2문장)",\n' +
    '  "components": [\n' +
    '    {\n' +
    '      "name": "부품명(한국어)",\n' +
    '      "hs6": "HS 6자리 숫자만",\n' +
    '      "typical_share_pct": 원가 비중 숫자,\n' +
    '      "importance": "core" 또는 "major" 또는 "minor",\n' +
    '      "typical_origins": ["주요 조달 국가1", "국가2"],\n' +
    '      "risk_flag": "high" 또는 "medium" 또는 "low",\n' +
    '      "risk_reason": "이 부품이 원산지 위장 대상이 되기 쉬운 이유 (1문장, low면 빈 문자열)"\n' +
    '    }\n' +
    '  ],\n' +
    '  "psr_hint": "이 품목의 원산지 결정 시 가장 결정적 부품·공정 (1문장)",\n' +
    '  "notes": "특이사항·주의점 (있으면)"\n' +
    '}\n\n' +
    '중요:\n' +
    '- HS 6자리는 실제 존재하는 코드를 정확히 사용. 확신 없으면 4자리(뒤에 "00")로.\n' +
    '- typical_share_pct 합계는 대략 60~100% (노무·이윤 포함으로 100 안 될 수 있음).\n' +
    '- risk_flag는 "완제품 생산국이 이 부품을 위장·우회 조달할 유인"이 있으면 high/medium.';

  const gen = geminiGenerate(systemInstr, prompt, cacheKey, 0.2, 4096, 'application/json');
  if (gen.error) return { error: gen.error };
  const result = gen.result;

  const parsed = robustJsonParse(result.text || '');
  if (parsed === null) {
    return {
      error: 'BOM JSON 파싱 실패 — 여러 방법 시도했으나 유효한 JSON 아님',
      raw_text: (result.text || '').substring(0, 1200),
      model: result.model
    };
  }

  return Object.assign({}, parsed, {
    _meta: {
      model: result.model,
      cached: result._cached || false,
      truncated: result.truncated,
      tokens: result.tokens
    }
  });
}


// ══════════════════════════════════════════════════════════
// [21] BOM 검토 — /api/gemini/bom-review
// ══════════════════════════════════════════════════════════

function bomReview(body) {
  body = body || {};
  const hs = String(body.hs || '').trim();
  const name = String(body.name || '').trim();
  const origin = String(body.origin || '').trim();
  const fta = String(body.fta || '').trim();
  const fob = body.fob || 0;
  const userBom = body.user_bom || [];

  if (!hs || hs.length < 6) return { error: 'HS 코드 6자리 이상 필요' };
  if (!userBom || !userBom.length) return { error: '검토할 BOM이 비어있음' };

  const cacheKeySrc = JSON.stringify({ hs: hs, name: name, origin: origin, fta: fta, bom: userBom });
  const cacheKey = 'bom-rev_' + Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, cacheKeySrc
  )).replace(/[^a-zA-Z0-9]/g, '');

  const systemInstr =
    '당신은 한국 관세청 원산지 검증관입니다. 수출자가 제출한 BOM을 검토하여 ' +
    '누락된 부품·비정상적 가액 배분·원산지 위장 가능성 있는 부품을 명확히 지적합니다. ' +
    '원산지 위반을 다수 다뤄본 조사관의 시각으로 답변합니다.';

  const prompt = '수출자가 제출한 BOM을 검토하여 JSON으로 판단·지적하세요.\n\n' +
    '【완제품】\n' +
    '- HS: ' + hs + '\n' +
    '- 품명: ' + (name || '(미입력)') + '\n' +
    '- 완제품 생산국(주장 원산지): ' + (origin || '(미지정)') + '\n' +
    '- 적용 FTA: ' + (fta || '(미지정)') + '\n' +
    '- FOB 단가: ' + fob + ' USD\n\n' +
    '【제출된 BOM】\n' + JSON.stringify(userBom, null, 2) + '\n\n' +
    '【검토 관점】\n' +
    '1. 이 완제품을 만드는 데 필요한 부품이 모두 포함되었는가? (누락 검증)\n' +
    '2. 특정 부품의 가액 비중이 실제 산업 관행 대비 비정상적인가? (저평가·과대평가)\n' +
    '3. 완제품 생산국이 이 부품을 자체 생산하기 어려운데 "국내산"으로 표시된 부품이 있는가?\n' +
    '4. 특정 부품의 원산지 신고가 산업 현실과 맞지 않는가? (예: 반도체 부품인데 통상 대만·한국이 아닌 국가로 표기)\n' +
    '5. HS 코드가 부품명과 매치되지 않는 경우.\n\n' +
    '【응답 형식 — 반드시 유효한 JSON 하나만】\n' +
    '{\n' +
    '  "verdict": "정상" 또는 "주의" 또는 "위험",\n' +
    '  "coverage_pct": 예상 BOM 대비 커버리지 숫자(0~100),\n' +
    '  "summary": "전체 검토 결과 1~2문장",\n' +
    '  "issues": [\n' +
    '    {\n' +
    '      "severity": "high" 또는 "medium" 또는 "low",\n' +
    '      "type": "missing" 또는 "abnormal_share" 또는 "suspicious_origin" 또는 "hs_mismatch",\n' +
    '      "part_name": "관련 부품명 (missing이면 누락된 부품명)",\n' +
    '      "message": "구체적 문제점",\n' +
    '      "suggestion": "필요한 조치·확인 사항"\n' +
    '    }\n' +
    '  ],\n' +
    '  "missing_components": [\n' +
    '    {\n' +
    '      "name": "누락된 부품",\n' +
    '      "hs6": "HS 6자리",\n' +
    '      "reason": "왜 이 완제품에 반드시 있어야 하는가"\n' +
    '    }\n' +
    '  ],\n' +
    '  "origin_realism": {\n' +
    '    "verdict": "합리적" 또는 "의심",\n' +
    '    "message": "완제품 생산국이 이 BOM으로 실제 제조 가능한가에 대한 판단 1~2문장"\n' +
    '  }\n' +
    '}\n\n' +
    '중요:\n' +
    '- 지적할 것이 없으면 issues·missing_components를 빈 배열로.\n' +
    '- verdict는 issues의 severity·개수 기반으로 결정 (high 하나라도 있으면 "위험").';

  const gen = geminiGenerate(systemInstr, prompt, cacheKey, 0.2, 3072, 'application/json');
  if (gen.error) return { error: gen.error };
  const result = gen.result;

  const parsed = robustJsonParse(result.text || '');
  if (parsed === null) {
    return {
      error: 'BOM 검토 JSON 파싱 실패 — 여러 방법 시도했으나 유효한 JSON 아님',
      raw_text: (result.text || '').substring(0, 1200),
      model: result.model
    };
  }

  return Object.assign({}, parsed, {
    _meta: {
      model: result.model,
      cached: result._cached || false,
      truncated: result.truncated,
      tokens: result.tokens
    }
  });
}


// ══════════════════════════════════════════════════════════
// [22] CBP CROSS (미국 관세청 판례) 자동 조회 — /api/cbp-cross/search
// ══════════════════════════════════════════════════════════

function cbpCrossSearch(params) {
  params = params || {};
  const hsRaw = (params.hs || '').trim();
  let pageSize = parseInt(params.page_size || '15', 10);
  if (pageSize > 50) pageSize = 50;
  if (pageSize < 1) pageSize = 1;

  if (!hsRaw) return { error: 'hs 파라미터 필수' };

  const digits = hsRaw.replace(/\D/g, '');
  if (digits.length < 6) return { error: 'HS 코드는 최소 6자리 필요' };
  const hs6 = digits.substring(0, 6);
  const usedTerm = hs6.substring(0, 4) + '.' + hs6.substring(4, 6);

  const cacheKey = 'cbp_cross_' + usedTerm + '_' + pageSize;
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  const url = 'https://rulings.cbp.gov/api/search?term=' + encodeURIComponent(usedTerm) + '&page=1&pageSize=' + pageSize;

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Origin-Verification-Tool)' }
    });
  } catch (e) {
    return { error: 'CBP CROSS 호출 실패: ' + String(e) };
  }
  if (response.getResponseCode() !== 200) {
    return { error: 'CBP CROSS 응답 ' + response.getResponseCode(), raw: response.getContentText().substring(0, 300) };
  }

  let data;
  try { data = JSON.parse(response.getContentText()); }
  catch (e) { return { error: 'CBP CROSS 응답 파싱 실패: ' + String(e) }; }

  const rulings = data.rulings || [];
  const totalHits = data.totalHits || 0;

  function hasCategory(r, kw) {
    return ((r.categories || '') + '').toLowerCase().indexOf(kw) >= 0;
  }
  const originRulings = rulings.filter(function (r) { return hasCategory(r, 'origin'); });
  const classRulings = rulings.filter(function (r) { return !hasCategory(r, 'origin') && hasCategory(r, 'classification'); });
  const otherRulings = rulings.filter(function (r) { return !hasCategory(r, 'origin') && !hasCategory(r, 'classification'); });

  function byDateDesc(a, b) { return (b.rulingDate || '') < (a.rulingDate || '') ? -1 : ((b.rulingDate || '') > (a.rulingDate || '') ? 1 : 0); }
  originRulings.sort(byDateDesc);
  classRulings.sort(byDateDesc);
  otherRulings.sort(byDateDesc);
  const sortedRulings = originRulings.concat(classRulings, otherRulings);

  const result = {
    hs_query: hsRaw,
    used_term: usedTerm,
    total_hits: totalHits,
    rulings: sortedRulings,
    counts: { origin: originRulings.length, classification: classRulings.length, other: otherRulings.length },
    sorted_by: 'origin_first_then_date',
    detail_url_base: 'https://rulings.cbp.gov/ruling/'
  };
  _cachePut(cacheKey, result, 21600);
  return result;
}


// ══════════════════════════════════════════════════════════
// [23] CBP CROSS 판례 상세 원문 fetch + Gemini 배치 요약 — /api/cbp-cross/summarize
// ══════════════════════════════════════════════════════════

function cbpCrossSummarize(body) {
  body = body || {};
  let rulingNumbers = body.rulingNumbers || [];
  if (!rulingNumbers.length) return { error: 'rulingNumbers 비어있음' };
  rulingNumbers = rulingNumbers.slice(0, 10);

  const cacheKey = 'cbp-sum_' + Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, rulingNumbers.slice().sort().join(',')
  )).replace(/[^a-zA-Z0-9]/g, '');
  const cached = _cacheGet(cacheKey);
  if (cached) return Object.assign({ _cached: true }, cached);

  // 1) 각 판례 원문 병렬 fetch (GAS: UrlFetchApp.fetchAll 로 ThreadPoolExecutor 대체)
  const requests = rulingNumbers.map(function (rn) {
    return {
      url: 'https://rulings.cbp.gov/api/ruling/' + encodeURIComponent(rn),
      muteHttpExceptions: true,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Origin-Verification-Tool)' }
    };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return { error: 'CBP CROSS 판례 병렬 조회 실패: ' + String(e) };
  }

  const fetched = [];
  for (let i = 0; i < rulingNumbers.length; i++) {
    const rn = rulingNumbers[i];
    try {
      const resp = responses[i];
      if (resp.getResponseCode() !== 200) { fetched.push({ rulingNumber: rn, error: 'HTTP ' + resp.getResponseCode() }); continue; }
      const data = JSON.parse(resp.getContentText());
      const text = (data.text || '').toString().trim();
      fetched.push({
        rulingNumber: rn,
        text: text.substring(0, 2500),
        subject: data.subject || '',
        categories: data.categories || ''
      });
    } catch (e) {
      fetched.push({ rulingNumber: rn, error: String(e) });
    }
  }

  const validItems = fetched.filter(function (f) { return f.text; });
  if (!validItems.length) return { error: '모든 판례 원문 fetch 실패', details: fetched };

  const itemsForPrompt = validItems.map(function (it) {
    return { rulingNumber: it.rulingNumber, subject: it.subject, categories: it.categories, text: it.text };
  });

  const systemInstr =
    '당신은 미국 관세청(CBP) 판례를 한국 관세청 원산지 조사관에게 요약해 주는 전문가입니다. ' +
    '각 판례가 어떤 제품·공정·판정 사유·결론을 담고 있는지 간결하게 정리합니다.';

  const inputJson = JSON.stringify(itemsForPrompt, null, 2);
  const prompt = '다음은 CBP(미국 관세청) 판례 ' + validItems.length + '건의 원문입니다.\n' +
    '각 판례를 관세청 원산지 조사관 관점에서 3-4문장으로 요약하세요.\n\n' +
    '【입력】\n' + inputJson + '\n\n' +
    '【요약 지침】\n' +
    '1. product_ko: 판례가 다루는 물품 (한 문장, 예: "자동차 에어컨용 증발기 어셈블리")\n' +
    '2. verdict_ko: 판정 결론 (한 문장, 예: "USMCA 원산지 부적격 · 원산지는 멕시코로 표시")\n' +
    '3. summary_ko: 판정 근거·핵심 공정 요약 (2-3문장)\n' +
    '   - 어떤 부품·공정이 어디서 이루어졌는지\n' +
    '   - 왜 그런 결론이 나왔는지 (세번변경 미충족·tariff shift 등)\n' +
    '   - 원산지 조사관이 유사 사례 판단 시 참고할 포인트\n\n' +
    '【응답 형식 — 반드시 유효한 JSON 하나만】\n' +
    '{\n' +
    '  "summaries": [\n' +
    '    {\n' +
    '      "rulingNumber": "판례번호",\n' +
    '      "product_ko": "물품 (한 문장)",\n' +
    '      "verdict_ko": "판정 결론 (한 문장)",\n' +
    '      "summary_ko": "근거·판단 요약 (2-3문장)"\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  const gen = geminiGenerate(systemInstr, prompt, null, 0.2, 6144, 'application/json');
  if (gen.error) return { error: gen.error, fetched_count: validItems.length };
  const result = gen.result;

  const parsed = robustJsonParse(result.text || '');
  if (parsed === null) {
    return { error: '요약 JSON 파싱 실패', raw_text: (result.text || '').substring(0, 800), model: result.model };
  }

  const response = {
    summaries: parsed.summaries || [],
    fetched_count: validItems.length,
    failed_count: fetched.length - validItems.length,
    _meta: { model: result.model, cached: false, tokens: result.tokens }
  };
  _cachePut(cacheKey, response, 21600);
  return response;
}


// ══════════════════════════════════════════════════════════
// [24] CBP CROSS 판례 배치 번역 (Gemini) — /api/cbp-cross/translate
// ══════════════════════════════════════════════════════════

function cbpCrossTranslate(body) {
  body = body || {};
  let items = body.items || [];
  if (!items.length) return { error: '번역할 items가 비어있음' };
  items = items.slice(0, 20);

  const cacheKey = 'cbp-tr_' + Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, JSON.stringify(items)
  )).replace(/[^a-zA-Z0-9]/g, '');

  const systemInstr =
    '당신은 미국 관세청(CBP) 판례를 한국어로 번역하는 전문가입니다. ' +
    '관세·원산지·HS 분류 전문 용어를 정확하게 번역하며, 한국 관세청에서 사용하는 용어와 일관되게 표현합니다.';

  const inputJson = JSON.stringify(items, null, 2);
  const prompt = '다음 CBP(미국 관세청) 판례의 subject(제목)과 categories(카테고리)를 자연스러운 한국어로 번역하세요.\n\n' +
    '【입력】\n' + inputJson + '\n\n' +
    '【번역 지침】\n' +
    '1. subject: 원문의 법적·기술적 의미를 정확히 유지. 지나친 의역 금지.\n' +
    '2. categories: 짧게. 예:\n' +
    '   - "Classification" → "분류"\n' +
    '   - "Origin" → "원산지"\n' +
    '   - "Marking" → "표시"\n' +
    '   - "Trade" → "무역"\n' +
    '   - "Origin, Trade" → "원산지, 무역"\n' +
    '3. 고유명사·법 이름(예: USMCA·NAFTA)은 원문 유지.\n' +
    '4. HS 코드·판례번호·서식번호는 원문 그대로.\n\n' +
    '【응답 형식 — 반드시 유효한 JSON 하나만】\n' +
    '{\n' +
    '  "translations": [\n' +
    '    {"id": items의 id 값, "subject_ko": "번역된 제목", "categories_ko": "번역된 카테고리"}\n' +
    '  ]\n' +
    '}';

  const gen = geminiGenerate(systemInstr, prompt, cacheKey, 0.1, 3072, 'application/json');
  if (gen.error) return { error: gen.error };
  const result = gen.result;

  const parsed = robustJsonParse(result.text || '');
  if (parsed === null) {
    return { error: '번역 JSON 파싱 실패', raw_text: (result.text || '').substring(0, 800), model: result.model };
  }

  return {
    translations: parsed.translations || [],
    _meta: { model: result.model, cached: result._cached || false, tokens: result.tokens }
  };
}
