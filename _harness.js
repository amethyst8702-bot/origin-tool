global.PropertiesService = {
  getScriptProperties: () => ({ getProperty: (k) => '' })
};
const _cache = {};
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => _cache[k] || null,
    put: (k, v) => { _cache[k] = v; },
  })
};
function fakeXml() {
  return '<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><year>2024</year><impDlr>100</impDlr><impWgt>10</impWgt><hsCd>0712901000</hsCd><statKor>test</statKor></item></items></body></response>';
}
global.UrlFetchApp = {
  fetch: (url, opts) => ({
    getResponseCode: () => 200,
    getContentText: () => {
      if (url.indexOf('rulings.cbp.gov') >= 0) return JSON.stringify({ rulings: [{rulingNumber:'N123456', categories:'Origin', rulingDate:'2020-01-01'}], totalHits: 1, text: 'sample ruling text', subject:'subj', categories:'Origin' });
      if (url.indexOf('apis.data.go.kr') >= 0) return fakeXml();
      if (url.indexOf('comtradeapi.un.org') >= 0) return JSON.stringify({ data: [{partnerCode:1,partnerDesc:'X',partnerISO:'CHN',primaryValue:100}] });
      if (url.indexOf('generativelanguage.googleapis.com') >= 0) return JSON.stringify({ candidates: [{content:{parts:[{text:'{"ok":true}'}]},finishReason:'STOP'}], usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2} });
      if (url.indexOf('worldbank.org') >= 0) return JSON.stringify([{page:1},[{value:20,date:'2023'}]]);
      if (url.indexOf('fao.org') >= 0) return JSON.stringify({ data: [{Year:2022, Value: 100, Unit:'tonnes'}] });
      if (url.indexOf('oecd.org') >= 0) return JSON.stringify({ dataSets: [{ series: { '0': { observations: { '0': [55.5] } } } }] });
      return '{}';
    }
  }),
  fetchAll: (requests) => requests.map(r => ({
    getResponseCode: () => 200,
    getContentText: () => {
      const url = r.url;
      if (url.indexOf('rulings.cbp.gov') >= 0) return JSON.stringify({ text: 'sample ruling text', subject:'subj', categories:'Origin' });
      if (url.indexOf('apis.data.go.kr') >= 0) return fakeXml();
      if (url.indexOf('comtradeapi.un.org') >= 0) return JSON.stringify({ data: [{partnerCode:1,partnerDesc:'X',partnerISO:'CHN',primaryValue:100}] });
      if (url.indexOf('fao.org') >= 0) return JSON.stringify({ data: [{Year:2022, Value: 100, Unit:'tonnes'}] });
      if (url.indexOf('oecd.org') >= 0) return JSON.stringify({ dataSets: [{ series: { '0': { observations: { '0': [55.5] } } } }] });
      if (url.indexOf('worldbank.org') >= 0) return JSON.stringify([{page:1},[{value:20,date:'2023'}]]);
      return '{}';
    }
  }))
};
global.ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput: (t) => ({ setMimeType: () => ({ _text: t }) })
};
global.Utilities = {
  base64Encode: (b) => Buffer.from(b).toString('base64'),
  computeDigest: (algo, s) => Buffer.from(String(s)),
  DigestAlgorithm: { MD5: 'MD5' },
  sleep: () => {},
  formatDate: () => '2026-07-14'
};
global.XmlService = {
  parse: (xml) => {
    // very small mock XML parser for our fake fixed XML structure
    return {
      getRootElement: () => ({
        getChild: (name) => {
          if (name === 'header') return { getChildText: (n) => n === 'resultCode' ? '00' : 'OK' };
          if (name === 'body') return {
            getChild: (n2) => n2 === 'items' ? {
              getChildren: (n3) => [{
                getChildren: () => [
                  { getName: () => 'year', getText: () => '2024' },
                  { getName: () => 'impDlr', getText: () => '100' },
                  { getName: () => 'impWgt', getText: () => '10' },
                  { getName: () => 'hsCd', getText: () => '0712901000' },
                  { getName: () => 'statKor', getText: () => 'test' }
                ]
              }]
            } : null
          };
          return null;
        }
      })
    };
  }
};

const fs = require('fs');
let code = fs.readFileSync('_verify.gs.txt', 'utf8');
eval(code);

function run(name, fn) {
  try {
    const r = fn();
    console.log('OK  ', name, '->', JSON.stringify(r).substring(0, 120));
  } catch (e) {
    console.log('FAIL', name, '->', e.stack || e.message);
  }
}

run('trade_flow', () => tradeFlow({ origin: '중국', transit: '베트남', hs: '071290', year: '2023' }));
run('trade_origin', () => tradeOrigin({ transit: '베트남', hs: '071290', year: '2023' }));
run('faostat_prod', () => faostatProduction({ country_iso3: 'CHN', item_code: '406' }));
run('faostat_trade', () => faostatTradeMatrix({ reporter_iso3: 'VNM', partner_iso3: 'CHN', item_code: '406' }));
run('oecd_tiva', () => oecdTiva({ country_iso3: 'CHN', sector: 'D29' }));
run('industry', () => industryProfile({ country: 'CHN' }));
run('origin_detect', () => { global.DATA_GO_KR_KEY = 'x'; return originDetect({ hs: '071290', transit: '베트남' }); });
run('component_inflow (korea)', () => componentInflow({ producer: '한국', hs: '071290' }));
run('component_inflow (foreign)', () => componentInflow({ producer: '중국', hs: '071290' }));
run('trade_stat', () => customsTradeStat({ hs: '0712901000', country: 'CN', from: '202301', to: '202312' }));
run('cbp_cross_search', () => cbpCrossSearch({ hs: '841480', page_size: 5 }));
run('cbp_cross_summarize', () => { global.GEMINI_KEY='x'; return cbpCrossSummarize({ rulingNumbers: ['N123456'] }); });
run('cbp_cross_translate', () => cbpCrossTranslate({ items: [{ id: 1, subject: 'test', categories: 'Origin' }] }));
run('bom_suggest', () => bomSuggest({ hs: '850440', name: 'test', origin: '중국', fta: '' }));
run('bom_review', () => bomReview({ hs: '850440', name: 'test', origin: '중국', fta: '', fob: 10, user_bom: [{name:'x', hs:'850440', price:1, share:50, origin:'중국'}] }));
run('handleAction/health', () => handleAction('health', {}, {}));
console.log('DONE');
