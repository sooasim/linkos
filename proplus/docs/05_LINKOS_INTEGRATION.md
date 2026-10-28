# PROPLUS ↔ LINKOS 연동 계약

결정: **단일 로그인 + 데이터 연동**. DB 는 분리된 채 두고 **HTTP 계약으로만** 오간다.
근거와 기각한 대안은 `02_ADR.md` ADR-012.

---

## 0. 이 문서가 지키려는 것

ADR-009 는 두 제품을 분리했다. 그 이유는 조직 편의가 아니라 **신뢰 모델이 반대**이기 때문이다:

| | LINKOS | PROPLUS |
|---|---|---|
| 핵심 동작 | 관계 강도를 **추정**한다 | 추정을 **금지**한다 (N-1) |
| 데이터 성격 | 내가 모은 연락처 | 제3자가 확인한 증거 |

연동한다고 이 차이를 섞으면 안 된다. 그래서 **한 방향 규칙**을 둔다:

> **검증된 사실은 PROPLUS → LINKOS 로만 흐른다. 추정된 관계는 반대로 흐르지 않는다.**

LINKOS 의 관계 점수가 PROPLUS 배지에 영향을 주는 경로는 만들지 않는다. 그 경로가 생기는 순간
"배지는 점수가 아니다"(N-3)가 거짓이 된다.

---

## 1. 단일 로그인 — LINKOS 가 신원 제공자

### 왜 LINKOS 가 제공자인가

사용자를 이미 갖고 있는 쪽이 제공자다. PROPLUS 가 제공자가 되면 기존 LINKOS 사용자에게
"새 계정을 만들라"고 요구하게 되고, 그건 연동이 아니라 분리다.

### 왜 쿠키 공유가 아닌가

두 호스트가 `*.ckp.kr` 라서 `.ckp.kr` 도메인 쿠키를 쓰면 "되기는" 한다. **쓰지 않는다** —
그 쿠키는 같은 영역의 **무관한 사이트 전부**(pt·link·bu·kakao·pay·shop)로 함께 전송된다.
세션 토큰을 그 사이트들의 로그에 흘리는 설계다.

### 왜 전체 OAuth 가 아닌가

두 앱 모두 **같은 운영자의 1st-party** 앱이다. 동의 화면·스코프·리프레시 토큰이 필요한 관계가 아니다.
필요한 것은 "이 브라우저의 LINKOS 사용자가 누구인지"를 한 번 전달하는 것뿐이라,
**서명된 단발 assertion** 으로 충분하다. 작을수록 틀릴 구석이 적다.

### 흐름

```
1. PROPLUS /login 에서 "LINKOS 계정으로 계속"
2. → https://linkos.ckp.kr/sso/proplus?redirect_uri=<PROPLUS>/login/linkos&state=<csrf>
3. LINKOS: 비로그인이면 자기 로그인 후 2번으로 복귀
4. LINKOS: 로그인돼 있으면 assertion 발급 후 리다이렉트
   → <PROPLUS>/login/linkos?assertion=<v1.payload.sig>&state=<csrf>
5. PROPLUS 서버가 assertion 검증 → { sub, email, displayName }
6. PROPLUS 가 email 로 자기 user 를 찾거나 만들고 pp_session 발급
```

### assertion 형식

```
v1.<base64url(payload)>.<base64url(hmac-sha256(payload, SSO_SHARED_SECRET))>

payload = {
  "iss": "linkos",
  "aud": "proplus",          // 고정. 다른 앱이 이 토큰을 재사용할 수 없다
  "sub": "<linkos user id>",
  "email": "<이메일>",
  "name": "<표시 이름 또는 null>",
  "jti": "<난수 16바이트 base64url>",   // 1회성 — 재생 공격 차단
  "iat": 1760000000,
  "exp": 1760000060          // 60초. 리다이렉트 한 번에 충분하고 유출 창은 짧다
}
```

**검증 규칙 (PROPLUS 쪽, 전부 필수)**
1. `v1.` 접두사 — 형식 버전
2. HMAC 상수시간 비교
3. `iss === "linkos"` 그리고 `aud === "proplus"`
4. `exp > now` 그리고 `iat <= now + 30s`(시계 오차 허용)
5. `jti` 가 **아직 쓰이지 않았을 것** — `sso_assertions` 테이블에 INSERT 하며 UNIQUE 로 막는다
6. `email` 이 있을 것 (PROPLUS 는 이메일로 계정을 잇는다)

**state** 는 PROPLUS 가 발급해 httpOnly 쿠키에 두고 복귀 시 대조한다(로그인 CSRF 차단).

### 계정 연결 규칙

- `users.email` 이 같으면 **기존 PROPLUS 계정에 연결**한다. 새로 만들지 않는다.
- 없으면 새로 만든다. 이때 `auth_provider = 'linkos'`.
- `linkos_user_id` 를 저장해 두되 **연결 식별용일 뿐** 권한 근거로 쓰지 않는다.
- LINKOS 에서 탈퇴·정지돼도 PROPLUS 계정은 자동으로 사라지지 않는다 —
  PROPLUS 의 증거·배지는 PROPLUS 의 것이다(N-12 와 같은 방향: 한쪽이 다른 쪽을 소유하지 않는다).

### 비밀값

`SSO_SHARED_SECRET` — 양쪽 env 에 같은 값. 32바이트 이상.
바꾸면 진행 중이던 로그인만 실패하고(60초 창) 기존 세션은 영향 없다.

---

## 2. 데이터 연동 ① PROPLUS 상담 → LINKOS 연락처

### LINKOS 수정이 필요 없다

LINKOS 에 이미 있다: `POST /api/v1/ext/leads`, scope `leads:write`,
`Authorization: Bearer lk_<prefix>_<secret>` (키는 sha256 해시로만 저장·폐기 가능·레이트리밋).

### 동의 경계 — 자동으로 보내지 않는다

상담 동의는 **"이 상담에 답변하기 위해"** 받은 것이다. 같은 담당자가 자기 CRM 에서 그 상담을
이어서 처리하는 것은 그 목적 안이라고 볼 수 있지만, **자동으로 켜 두지 않는다**:

- **프로필 소유자가 켠다** (`public_settings.linkosSync = true`). 기본값 꺼짐.
- 켜져 있을 때만 `lead.created` outbox 소비자가 LINKOS 로 보낸다.
- **동의를 더 받지 않는다.** 전달은 소유자의 결정이지 제출자가 준 동의가 아니다 —
  `consent_records` 에 쓰면 받지 않은 동의를 기록하는 것이 된다. 대신 `audit_logs` 와
  `integration_deliveries` 에 처리 기록으로 남기고, 개인정보 안내에 사실을 적는다.
- 보낸 사실을 `audit_logs` 에 남긴다 (`integration.lead_forwarded`).
- **개인정보 처리 안내에 이 사실을 적는다** — 적지 않고 보내면 그게 거짓말이다.
- 마케팅 동의 여부는 **보내지 않는다.** LINKOS 쪽에서 마케팅 발송 근거로 오용될 수 있다.

### 매핑

| PROPLUS | LINKOS `contactInput` |
|---|---|
| `contact_name` | `fullName` |
| 복호화된 연락처 (`kind === 'email'`) | `email` |
| 복호화된 연락처 (`kind === 'phone'`) | `phone` |
| 프로필 소유 조직 이름 | `company` |
| — | `source: "import"` (enum 에 외부 유입에 맞는 값이 이것뿐) |
| `message` | `encounter.note` (2000자 상한) |
| `purpose` | `tags: ["proplus", <purpose>]` |
| — | `provenance: { email: { source: "proplus", confidence: 1 } }` |

`provenance` 를 채우는 이유: LINKOS 는 출처별 신뢰도를 쓴다. PROPLUS 상담은 **본인이 직접 입력한**
연락처라 confidence 1 이 정직하다(OCR 추정값과 구분된다).

### 실패 처리

outbox 소비자이므로 **idempotent** 여야 한다(P-184). LINKOS 가 5xx 를 주면 재시도,
4xx(키 폐기·스코프 부족)면 재시도하지 않고 `last_error` 에 남기고 멈춘다 —
잘못된 키로 무한 재시도하면 LINKOS 의 레이트리밋만 태운다.

---

## 3. 데이터 연동 ② LINKOS 에서 PROPLUS 검증 배지 보기

### 프라이버시가 설계를 정한다

"이 이메일의 PROPLUS 배지를 알려줘"를 그대로 열면 **이메일 존재 확인 오라클**이 된다.
누구나 이메일 목록을 넣어 "이 사람이 PROPLUS 에 있는지"를 알아낼 수 있다.

그래서 세 겹을 건다:

1. **소유자 opt-in** — `public_settings.allowDirectoryLookup = true` 인 프로필만 응답에 나온다. 기본 꺼짐.
2. **해시 입력** — 평문 이메일이 아니라 `sha256(lower(trim(email)) + DIRECTORY_SALT)` 를 받는다.
   조회하려면 **정확한 이메일을 이미 알고 있어야** 한다(명함을 교환한 사이라면 안다).
3. **API 키 + 레이트리밋 + 감사로그** — 누가 얼마나 조회했는지 남는다.

### 계약

```
POST /api/v1/ext/badges/lookup
Authorization: Bearer pp_<prefix>_<secret>
{ "emailHashes": ["<sha256 hex>", ...] }   // 최대 50개

200 {
  "results": [
    { "emailHash": "...", "slug": "demo-pro", "displayName": "김영업",
      "badges": [ { type, label, method, methodLabel, scope, verifiedAt, expiresAt, disputed } ],
      "profileUrl": "https://proplus.ckp.kr/p/demo-pro" }
  ],
  "basis": { "source": "public_badge_view", "evaluatedAt": "..." }
}
```

- 찾지 못한 해시는 **응답에 넣지 않는다**(없음을 명시적으로 알려 주지 않는다).
- 배지는 `public_badge_view` 를 거친다 — 만료·취소·자기기재는 애초에 나오지 않는다(N-9/N-1).
- `disputed` 를 그대로 내보낸다. LINKOS 가 "확인 필요"로 그릴 수 있어야 한다(N-14).

### LINKOS 쪽 표시 규칙

LINKOS 가 이 데이터를 그릴 때 지켜야 하는 것 (PROPLUS 의 요구가 아니라 **사실의 요구**):

- 배지 옆에 **확인 방식·범위·확인일**을 함께 표시한다. 라벨만 떼어 쓰면 P-058 이 깨진다.
- 출처가 PROPLUS 임을 밝힌다.
- `disputed` 는 "확인 필요"로만 표시한다.
- 배지 **개수를 세어 점수처럼 보이게 하지 않는다** (N-3).

---

## 4. 격리는 그대로 유지된다

| | 상태 |
|---|---|
| DB | **분리.** 서로의 테이블을 읽지 않는다 |
| 코드 | `@proplus/*` 가 `@linkos/*` 를 import 하지 않는다 (architecture.test.ts 가 강제) |
| 세션 쿠키 | `pp_session` / `lk_session` 분리 유지 |
| 기능 원장 | `P-xxx` / `F-xxx` 분리 유지 |
| 배포 | systemd(4400) / Docker(4300) 분리 유지 |
| 오가는 것 | **HTTP 계약 3개뿐** — SSO assertion, `ext/leads` 호출, `ext/badges/lookup` |

---

## 5. 환경변수

| 변수 | 어디에 | 뜻 |
|---|---|---|
| `SSO_SHARED_SECRET` | 양쪽 | assertion HMAC 키 (32바이트 이상) |
| `LINKOS_BASE_URL` | PROPLUS | `https://linkos.ckp.kr` |
| `LINKOS_API_KEY` | PROPLUS | `lk_…` (scope `leads:write`) |
| `DIRECTORY_SALT` | 양쪽 | 이메일 해시 솔트 |
| `PROPLUS_BASE_URL` | LINKOS | `https://proplus.ckp.kr` |
| `PROPLUS_API_KEY` | LINKOS | `pp_…` (scope `badges:read`) |

비면 **그 연동만 조용히 꺼진다** — 전체가 죽지 않는다. 연동은 부가 기능이고
PROPLUS 의 핵심(검증·공개 프로필·상담)은 LINKOS 없이 동작해야 한다.

---

## 6. 구현 범위

| 단계 | 내용 | 수정 대상 |
|---|---|---|
| ① SSO | assertion 발급/검증, `/login/linkos`, 계정 연결 | 양쪽 |
| ② 리드 전달 | outbox 소비자 + opt-in 설정 + 안내 문구 | PROPLUS |
| ③ 배지 조회 | `ext/badges/lookup` + API 키 + opt-in | PROPLUS (LINKOS 표시는 후속) |
| ④ 화면 링크 | 상호 이동 링크 | 양쪽 |
