# 회사 서버 이전 메모

작성일: 2026-10-01

## 현재 구조

GitHub Pages의 index.html과 정적 데이터 JS 8개가 화면 및 분석을 제공한다. 외부 통계와 AI 요청은 GAS 웹앱을 통해 처리한다. API 키는 GAS Script Properties에 있다.

기존 사이트: https://amethyst8702-bot.github.io/fta-check/
테스트 사이트: https://amethyst8702-bot.github.io/origin-tool/

개발 출발점은 priority1 수정본이다. 실제 GAS 배포 코드와 첨부 코드의 일치 여부는 미확인이다.

## 이전 전략

기존 분석 기능과 데이터 의미를 유지하면서 백엔드를 회사 서버로 교체한다. 주소 변경만으로 이전이 완료되는 것은 아니다.

1. 실제 운영 GAS 코드를 확보하고 배포 버전·설정 항목·action별 요청과 응답을 기록한다. API 키 값은 문서에 기록하지 않는다.
2. 회사 서버에서 현재 action 기반 JSON API를 구현한다. 기본 요청 형태는 { action, params, body }이다.
3. index.html의 [DEPLOYMENT SWITCH] 블록에 있는 APP_CONFIG.API_BASE를 변경한다. 별도 FEEDBACK_GAS_URL도 변경하거나 같은 설정으로 통합한다.
4. CORS·인증·접근 권한·HTTPS·제한시간을 구성한다. GAS용 POST와 리다이렉트 처리가 회사 서버에 적합한지 검토한다.
5. PropertiesService·CacheService·UrlFetchApp·ContentService·Utilities·XmlService를 회사 서버의 대응 기능으로 교체한다.
6. GEMINI_KEY·GEMINI_MODEL·COMTRADE_KEY·DATA_GO_KR_KEY를 회사 환경변수 또는 비밀값 관리 시스템으로 이전한다.
7. 정적 데이터의 구조·단위·기간·출처를 보존한다. DB 전환은 별도 단계로 진행하고 기존 조회 결과와 비교한다.
8. 테스트 환경에서 동일 입력으로 이전 전후 결과를 비교한 뒤 운영 전환한다. 기존 배포본과 설정을 복구 가능한 상태로 보관한다.

## 이전 전에 보완할 사항

- 실제 서버 응답에 근거한 연결 확인: 현재 /health 어댑터는 실제 결과를 기다리지 않고 정상 응답을 반환한다.
- 실제 요청에 취소 신호와 제한시간 전달: 현재 GAS 호출에는 신호가 전달되지 않는다.
- 피드백을 포함한 API 주소 설정 통일.
- 실제 배포된 GAS 코드와 작업 파일의 버전 일치 확인.

브라우저 요청을 취소해도 이미 시작된 GAS 또는 회사 서버의 처리까지 자동으로 중단되는 것은 아니다. 서버 측 제한시간과 중복 실행 처리도 검토한다.

## 검증 항목

- 데이터 로딩과 HS·국가·협정 선택
- PSR·세율·수입 실적 등 정적 분석
- 외부 통계와 AI 결과
- BOM·CBP 등 대표 시연 기능
- API 오류·데이터 부재·비정상 응답 처리
- 취소·제한시간과 재실행
- PDF·HTML 보고서 저장
- 피드백 전송과 저장 위치

_harness.js·_harness2.js·_verify.js는 실제 테스트 범위를 확인한 뒤 활용한다. 모의 검증과 실제 외부 API 검증 결과를 따로 기록한다.

개발 원칙과 자세한 체크포인트는 AGENTS.md를 참조한다.
