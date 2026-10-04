# SEO 키워드 리서처 GPT (1단계: 키워드 발굴)

SEO 블로그 글 작성 4단계 중 **1단계**를 맡는 맞춤형 GPT입니다.
주제를 입력하면 → 핵심 단어 추출 → 후보 확장 → 수요·공급·트렌드·노출 기회 점수화 →
**키워드 50개(가로 5 × 세로 10) 표 + 선정 기준 + TOP 10**을 출력합니다.

```
custom-gpts/seo-keyword-gpt/
├── README.md                                  ← 이 설정 가이드
├── instructions.md                            ← GPT "지침(Instructions)"에 붙여넣기
├── knowledge/keyword-scoring-guide.md         ← GPT "지식(Knowledge)"에 업로드
├── actions/keyword-proxy.openapi.yaml         ← Action ① (필수 권장)
├── actions/google-search-console.openapi.yaml ← Action ② (선택, 내 블로그가 있을 때)
└── proxy/worker.js, wrangler.toml             ← Action ①이 호출할 데이터 서버
```

---

## 꼭 알아야 할 점: GPT는 브라우저 확장 프로그램을 실행할 수 없습니다

Keywords Everywhere 같은 **키워드 검색 확장 프로그램은 ChatGPT 안에서 동작하지 않습니다.**
그래서 이 GPT는 확장 프로그램이 내부에서 쓰는 것과 같은 데이터를 **API로 직접** 가져옵니다.

| 원하신 도구 | GPT에서 쓰는 방법 | 얻는 지표 |
|---|---|---|
| 키워드 검색 확장 프로그램 (Keywords Everywhere) | 같은 회사의 **Keywords Everywhere API** (선택) | 구글 검색량, CPC, 연관 키워드 |
| 네이버 키워드 도구 (검색광고) | **네이버 검색광고 API** | 월간 PC/모바일 검색량, 광고 경쟁도, 연관 키워드 |
| 블로그 문서 수 조회 | **네이버 검색 API (블로그)** | 누적 문서 수, 상위 글 게시일, 최근 30일 발행량 |
| 네이버 데이터랩 | **네이버 데이터랩 검색어 트렌드 API** | 12개월 검색 추이, 증감률, 성수기 |
| 구글/네이버 자동완성 | 공개 자동완성 엔드포인트 | 실제 사용자가 입력하는 롱테일 후보 |
| Google Search Console | **Search Console API** (Action ②, 선택) | 내 사이트가 이미 노출 중인 키워드·순위 |
| Google Analytics | 1단계에는 쓰지 않음 | GA는 검색어 수요를 보여주지 않습니다. 글 발행 후 성과 분석(후속 단계)에 적합 |

> Actions 없이 만들어도 GPT는 동작합니다. 이 경우 웹 검색으로 조사하는 **추정 모드**(상/중/하 평가)로 결과를 냅니다.
> 실제 검색량 기반 점수를 원하면 아래 3단계에서 Action ①을 연결하세요.

---

## 1단계. GPT 기본 정보 입력

ChatGPT → **GPT 탐색 → 만들기 → 구성(Configure)** 탭

| 항목 | 입력값 |
|---|---|
| **이름** | SEO 키워드 리서처 |
| **설명** | 주제만 입력하면 검색 수요는 많고 경쟁은 적은 SEO 키워드 50개를 점수화해 표로 정리하고 TOP 10을 골라 드립니다. |
| **지침** | `instructions.md` 내용 전체를 복사해 붙여넣기 (약 5,300자, 한도 8,000자) |
| **대화 스타터** | 아래 4개 |
| **지식** | `knowledge/keyword-scoring-guide.md` 업로드 |
| **기능** | ✅ 웹 검색 · ✅ 코드 인터프리터 및 데이터 분석 · ⬜ 이미지 생성(불필요) |
| **추천 모델** | 추론 성능이 좋은 최신 모델 |

**대화 스타터**
1. `캠핑 의자` 주제로 키워드 50개 뽑아줘
2. `다이어트 도시락` 블로그 키워드 TOP 10 찾아줘
3. `제주도 가족여행` 주제로 경쟁 적은 키워드 분석해줘
4. 선정 기준(점수 계산 방식) 자세히 알려줘

---

## 2단계. 데이터 서버(프록시) 배포 — Action ①용

GPT Actions는 인증 헤더를 **하나만** 보낼 수 있고, 네이버 검색광고 API가 요구하는 **HMAC 서명**을 만들 수 없습니다.
그래서 작은 서버(Cloudflare Worker, 무료)가 모든 API 키를 보관하고 계산까지 대신합니다.

### 2-1. API 키 발급
| 키 | 발급처 | 비용 |
|---|---|---|
| 네이버 검색광고 API (액세스 라이선스, 비밀 키, 고객 ID) | searchad.naver.com → 도구 → API 사용 관리 | 무료 (광고 계정만 있으면 됨, 광고비 불필요) |
| 네이버 오픈 API (Client ID / Secret) | developers.naver.com → 애플리케이션 등록 → 사용 API에 **검색**, **데이터랩(검색어 트렌드)** 추가 | 무료 (검색 일 25,000회, 데이터랩 일 1,000회) |
| Keywords Everywhere API (선택) | keywordseverywhere.com → API | 유료 크레딧 |

### 2-2. 배포
```bash
cd custom-gpts/seo-keyword-gpt/proxy
npx wrangler login

# GPT와 서버 사이 비밀번호: 길고 랜덤한 문자열을 직접 만들어 사용
npx wrangler secret put PROXY_API_KEY
npx wrangler secret put NAVER_AD_ACCESS_LICENSE
npx wrangler secret put NAVER_AD_SECRET
npx wrangler secret put NAVER_AD_CUSTOMER_ID
npx wrangler secret put NAVER_CLIENT_ID
npx wrangler secret put NAVER_CLIENT_SECRET
npx wrangler secret put KE_API_KEY     # 선택

npx wrangler deploy
# → https://seo-keyword-proxy.<내-서브도메인>.workers.dev 주소가 출력됨
```

### 2-3. 동작 확인
```bash
curl -s -X POST https://seo-keyword-proxy.<내-서브도메인>.workers.dev/analyze \
  -H "Authorization: Bearer <PROXY_API_KEY>" -H "Content-Type: application/json" \
  -d '{"keywords":["캠핑의자","캠핑의자 추천"]}'
```

---

## 3단계. Action 연결

### Action ① 키워드 데이터 (권장)
1. 구성 탭 하단 **새 작업 만들기**
2. **인증** → API 키 → 인증 유형 **Bearer** → 값에 `PROXY_API_KEY` 입력
3. **스키마** → `actions/keyword-proxy.openapi.yaml` 붙여넣기 → `servers.url`을 2-2에서 받은 주소로 수정
4. **개인정보 처리방침** → `https://seo-keyword-proxy.<내-서브도메인>.workers.dev/privacy`
5. 미리보기에서 `expandKeywords`, `analyzeKeywords` 테스트 → 처음 호출 시 **"항상 허용"** 선택(15개씩 여러 번 호출하므로)

### Action ② Google Search Console (선택 — 운영 중인 블로그가 있을 때)
내 사이트가 이미 8~20위에 노출되는 키워드에 🔥 표시를 붙여 "조금만 보강하면 1페이지에 오를 키워드"를 알려줍니다.
1. Google Cloud Console → 프로젝트 생성 → **Google Search Console API** 사용 설정
2. OAuth 동의 화면 구성 → **OAuth 클라이언트 ID(웹 애플리케이션)** 생성
3. GPT에서 새 작업 → 스키마에 `actions/google-search-console.openapi.yaml` 붙여넣기
4. 인증 → **OAuth**
   - 클라이언트 ID / 비밀번호: 2에서 발급한 값
   - 인증 URL: `https://accounts.google.com/o/oauth2/v2/auth`
   - 토큰 URL: `https://oauth2.googleapis.com/token`
   - 범위: `https://www.googleapis.com/auth/webmasters.readonly`
5. 저장 후 표시되는 **콜백 URL**을 Google OAuth 클라이언트의 "승인된 리디렉션 URI"에 추가

---

## 선정 기준 요약 (자세한 공식은 knowledge 파일)

| 지표 | 배점 | 측정 방식 | 높은 점수의 의미 |
|---|---|---|---|
| 수요 | 40 | 최근 30일 PC+모바일 검색량 (로그 스케일) | 찾는 사람이 많다 |
| 경쟁 | 30 | 누적 블로그 문서 수 ÷ 월간 검색량 | 수요 대비 글이 적다 |
| 트렌드 | 15 | 최근 3개월 ÷ 직전 3개월 검색 지수 | 관심이 늘고 있다 |
| 노출 기회 | 15 | 상위 10개 글 평균 경과일 + 최근 30일 발행량 | 새 글이 상위에 들어갈 틈이 있다 |

등급: **S** 80+ · **A** 65~79 · **B** 50~64 · **C** 35~49 · **D** 35 미만

## 출력 예시 (형식)

**키워드 50선**

| 1열 | 2열 | 3열 | 4열 | 5열 |
|---|---|---|---|---|
| 1. 캠핑의자 추천 (S·86) | 2. 경량 캠핑의자 (S·83) | 3. 릴렉스 체어 (A·78) | 4. 캠핑의자 브랜드 (A·75) | 5. 캠핑의자 높이 (A·73) |
| 6. … | 7. … | 8. … | 9. … | 10. … |
| ⋮ | | | | |
| 46. … | 47. … | 48. … | 49. … | 50. … |

**TOP 10**

| 순위 | 키워드 | 등급 | 총점 | 월간 검색량 | 누적 문서 수 | 경쟁 비율 | 트렌드 | 노출 기회 | 검색 의도 | 추천 글 유형 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 캠핑의자 추천 | S | 86 | 24,300 | 18,200 | 0.75 | +18% | 11.2 | 비교형 | 비교 리뷰 |

> 위 숫자는 형식 예시이며 실제 값은 조회 시점 데이터로 계산됩니다.

---

## 다음 단계와 연결하기
1단계 결과 마지막에 "다음 단계에서 쓸 키워드 번호를 골라 주세요"로 끝나도록 설계했습니다.
2~4단계 GPT를 만들 때 **TOP 10 표를 그대로 입력으로 받는** 형식으로 맞추면 단계 간 연결이 매끄럽습니다.
