# 원산지 결정기준 위반 위험 탐색 툴 — 개발 지침

## 목표와 기준본

2026년 10월 시연을 위해 GitHub Pages + Google Apps Script(GAS) 환경에서 안정적으로 작동하도록 한다. 기존 정상 기능을 유지하면서 오류 처리와 분석 근거를 개선한다.

- 기존 사이트: https://amethyst8702-bot.github.io/fta-check/
- 테스트 사이트: https://amethyst8702-bot.github.io/origin-tool/
- 개발 출발점: fta-check-priority1.zip
- 비교용 백업: fta-check-main.zip
- 2026-10-01 확인 상태: 테스트 페이지 열림은 사용자 확인. 전체 API·AI 동작은 미검증.
- 다운로드 이름의 (1), (2)는 버전 번호가 아니다.

## 구성

- 화면과 분석 로직: index.html
- 정적 데이터: tariff_rates.js, import_volume.js, psr_by_fta.js, psr_fulltext.js, hs_codes.js, standard_names.js, cases.js, bom_standards.js
- 백엔드: 별도 GAS 웹앱
- 비밀값: GAS Script Properties
- 문서: README.md, AGENTS.md, MIGRATION_NOTES.md

현재 웹 배포본은 로컬 proxy.py를 실행하지 않는다. 실제 GAS 배포 코드와 첨부 코드의 일치 여부는 아직 확인되지 않았다. _verify.js를 배포용 서버 코드로 간주하지 않는다.

## 개발 원칙

1. 시연 전 대규모 재작성보다 오류 제거와 기존 기능 유지에 집중한다.
2. 외부 API 연결은 기존 API 어댑터 경계를 사용한다.
3. API 주소·모델·키 등 환경 설정을 업무 분석 규칙과 분리한다.
4. API 키를 프런트엔드나 공개 저장소에 넣지 않는다. config.json·키 메모·설정 백업도 공개 업로드하지 않는다.
5. 외부 조회 하나가 실패해도 가능한 정적 데이터 분석은 계속 제공한다.
6. 확인된 사실, 데이터 부재, 추정 결과를 구분한다. 조회 실패를 위험 없음으로 해석하지 않는다.
7. 기존 사이트와 테스트 사이트에 같은 입력을 사용해 결과를 비교한다.
8. 변경 날짜·파일·내용·검증 결과를 README에 기록한다.
9. 페이지 열림, 문법 검사, 모의 테스트, 실제 외부 API 검증을 구분해 보고한다.

## 우선 보완 사항

2026-10-01 코드 검토와 모의 테스트에서 원본과 priority1에 공통으로 확인한 사항이다.

1. /health 요청에 실제 GAS 결과를 기다리지 않고 ok: true를 반환하는 동작을 수정한다.
2. API 어댑터에서 실제 fetch로 취소 신호를 전달하고 제한시간 동작을 검증한다. 브라우저 요청 취소가 GAS 서버 실행 중단을 보장하지는 않는다.
3. APP_CONFIG.API_BASE와 별도로 고정된 FEEDBACK_GAS_URL의 관리 방식을 통일한다.
4. 실제 GAS 배포 코드와 작업 파일을 대조해 서버 기준본을 확정한다.
5. 대표 시연 입력으로 데이터 로딩, 외부 조회, AI, BOM, CBP, 보고서 저장을 확인한다.

## 회사 서버 이전 체크포인트

### 설정 변경 위치

index.html의 [DEPLOYMENT SWITCH] 블록에 APP_CONFIG.API_BASE가 있다. PROXY_BASE는 이 값을 참조하는 호환 별칭이다. FEEDBACK_GAS_URL은 현재 별도 주소이므로 함께 확인한다.

BACKEND_TYPE과 API_CONTRACT_VERSION은 선언만으로 서버 전환이나 계약 검증을 수행하지 않는다. 실제 사용 코드를 확인한다.

주소 변경만으로 이전이 완료되지는 않는다. 회사 서버는 아래 API 계약과 브라우저 연결 조건을 구현해야 한다.

### 요청·응답 계약

기존 apiProxyCall()은 /api/... 요청을 action 기반 JSON으로 변환해 POST한다.

요청 구조: { action, params, body }

주요 action:
health, gemini, gemini_usage, gemini_models, comtrade, worldbank, trade_flow, trade_origin, faostat_trade, faostat_prod, oecd_tiva, industry, country_iso, cbp_cross_search, cbp_cross_summarize, cbp_cross_translate, bom_suggest, bom_review, origin_detect, component_inflow, trade_stat.

피드백 관련 기능은 feedback_submit, feedback_link도 확인한다. 각 action의 실제 지원 여부와 응답 필드는 운영 GAS 코드와 대조한다. 현재 어댑터의 HTTP 상태·JSON 오류 처리도 함께 검토한다.

### GAS 전용 기능 교체

PropertiesService, CacheService, UrlFetchApp, ContentService, Utilities, XmlService 등은 회사 서버 기술스택의 대응 기능으로 교체한다. 업무 규칙과 데이터 의미는 유지한다.

### 인증과 브라우저 연결

CORS, 인증, 접근 권한, HTTPS, 요청 제한시간을 구성한다. 현재 GAS용 POST·리다이렉트 처리 방식이 새 서버에도 적합한지 확인한다.

### 비밀값과 데이터

GEMINI_KEY, GEMINI_MODEL, COMTRADE_KEY, DATA_GO_KR_KEY는 회사 환경변수 또는 비밀값 관리 시스템으로 이전한다.

정적 데이터 8개의 구조·단위·기간·출처를 보존한다. DB로 이전한다면 기존 조회 결과와 비교한다.

### 검증

_harness.js, _harness2.js, _verify.js의 실제 검증 범위를 먼저 확인한다. 모의 테스트 통과를 실제 외부 API 성공으로 간주하지 않는다. 이전 전후 동일 입력의 결과, 실패 처리, 취소, 보고서 출력을 비교한다.

## 버전 관리

날짜와 변경 내용을 기록하고 작업본·배포본·백업본을 구분한다. GAS 편집기 코드와 배포 버전도 별도로 기록한다. 공개 사이트의 변경은 GitHub 커밋과 Pages 배포 완료 여부를 함께 확인한다.
