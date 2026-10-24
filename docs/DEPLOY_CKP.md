# LINKOS 배포 런북 — linkos.ckp.kr

> **⚠️ 2026-10-22 확인: 지금 돌고 있는 것은 아래 systemd 배포가 아니다.**
>
> `ssh ckp` 는 `1.234.82.36` 으로 가고, 거기에는 `/var/www/linkos` 도 `linkos-web.service` 도
> `/etc/linkos` 도 없다. 실제로 서비스하는 것은 **Docker compose 스택**이다 →
> [아래 "실제 배포 (Docker)"](#실제-배포-docker). 이 문서의 나머지(systemd·`/var/www/linkos`·
> `deploy-ckp.sh`·GitHub Actions 자동배포)는 다른 호스트(`1.234.5.14`)를 전제로 쓴 것이고,
> 지금 운영 중인 호스트에는 해당하지 않는다. 둘 중 무엇을 정본으로 할지 정해야 한다.

운영 중인 **공용 서버**(cafe24 `1.234.5.14`, hostname `ckp24.cafe24.com`)에 LINKOS 를 올린 기록이다.
이 서버에는 ckp.kr·pt·link·woori·kakao·pay·bu 등 **다른 사이트가 이미 돌고 있다.** 아래 전제를 깨지 말 것.

| 항목 | 값 |
|---|---|
| 주소 | https://linkos.ckp.kr (Cloudflare 프록시, Full strict) |
| 소스 | `/var/www/linkos` (GitHub `sooasim/linkos` 얕은 clone) |
| 런타임 | `/opt/node24/bin/node` (v24) — 시스템 node 는 v20 이라 `engines: >=22` 를 못 맞춘다 |
| 웹/API | `linkos-web.service` → `127.0.0.1:4300` (루프백 전용) |
| 워커 | `linkos-worker.service` (outbox·연동·예약 삭제) |
| DB | 기존 PostgreSQL 14 클러스터의 `linkos` DB / `linkos` 롤 |
| 설정 | `/etc/linkos/linkos.env` (root:linkos 640) |
| 업로드 | `/var/lib/linkos/storage` (`OBJECT_STORAGE_DRIVER=local`) |
| vhost | `/etc/nginx/sites-available/linkos-kr` + `/etc/nginx/conf.d/linkos.conf` |
| 인증서 | `/etc/ssl/ckp/pt.pem`·`pt.key` (Cloudflare Origin 와일드카드 `*.ckp.kr`, 2041 만료) |

## 재배포

```bash
ssh ckp 'bash /var/www/linkos/scripts/deploy-ckp.sh'
```

멱등하다. 소스 갱신 → 설치 → 빌드 → 정적 자산 배치 → 마이그레이션 → 재시작 → 헬스체크 순이고,
빌드가 끝난 뒤에야 재시작하므로 중간에 실패하면 **이전 빌드가 계속 서비스된다.**
배포가 실제로 바뀌었는지는 `revision` 으로 확인한다.

```bash
curl -s https://linkos.ckp.kr/api/v1/health
# {"status":"ok","db":"ok","migrations":18,"version":"1.0.0","revision":"06a1819",
#  "ai":{"enabled":true,"models":{"cheap":"claude-haiku-5-5","standard":"claude-sonnet-5-5","deep":"claude-opus-5-5"}}}
```

## 실제 배포 (Docker)

2026-10-22 에 `ssh ckp` 로 확인한 지금의 운영 형태다.

| 항목 | 값 |
|---|---|
| 호스트 | `1.234.82.36` (`ssh ckp`, root, RAM 32GB / 디스크 여유 180GB) |
| 소스 | `/opt/linkos` — **git 체크아웃이 아니다.** 개발 기계에서 트리를 복사해 둔 것(소유자 uid 197609) |
| 스택 | docker compose 프로젝트 `infra` → `infra-web-1`(127.0.0.1:4300→3000) · `infra-worker-1` · `infra-db-1`(pgvector pg16) |
| 설정 | `/opt/linkos/.env` — **지금은 컨테이너에 전달되지 않고 있다** (아래 경고) |
| 공개 주소 | https://linkos.ckp.kr (Cloudflare → nginx → 127.0.0.1:4300) |

재배포(소스를 갈아 끼운 뒤):

```bash
cd /opt/linkos && docker compose --env-file .env \
  -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
```

이미지 빌드가 F-015 OCR 모델 33MB 를 내려받아 `public/` 에 넣는다(`scripts/ocr/fetch-models.mjs`,
sha256 확인). 받지 못해도 빌드는 계속되고, 모델이 없으면 스캔이 tesseract 로 돈다 →
[docs/OCR_ENGINE.md](OCR_ENGINE.md). 배포 뒤 확인:

```bash
curl -sI https://linkos.ckp.kr/models/ocr/ch_PP-OCRv5_det_mobile.onnx | head -3   # 200 이어야 PP-OCRv5 가 쓰인다
```

빌드가 성공한 뒤에만 컨테이너가 교체되므로, 중간에 실패하면 이전 컨테이너가 계속 서비스한다.
롤백은 `infra-web:rollback-<타임스탬프>` 태그와 `/opt/linkos-src-<타임스탬프>.tgz` 로 한다
(배포 직전에 만들어 두는 것이 관례다).

소스를 넣는 방법은 git 이 아니라 tarball 이다 — 개발 기계에서:

```bash
git archive --format=tar.gz -o /tmp/linkos-deploy.tgz <커밋>
scp /tmp/linkos-deploy.tgz ckp:/tmp/
ssh ckp 'tar xzf /tmp/linkos-deploy.tgz -C /opt/linkos'   # .env 는 추적 대상이 아니라 보존된다
```

> **⚠️ `--env-file .env` 없이 올리면 안 된다.**
>
> `infra/docker-compose.yml` 은 로컬 실행용이라 `APP_ORIGIN=http://localhost:3000`,
> `AUTH_SECRET=change-me-local-only`, `OTP_DEV_ECHO=1` 이라는 개발 기본값을 갖고 있다.
> 2026-10-22 에 `docker compose … up --dry-run` 이 "컨테이너 교체 없음" 으로 나온 것으로
> 보아 **지금 떠 있는 스택이 바로 그 기본값으로 돌고 있다.** `OTP_DEV_ECHO=1` + SMTP 미설정이면
> `/api/v1/auth/otp` 응답에 로그인 코드가 그대로 담긴다
> (`services/api/src/modules/identity.ts:74`) — 누구나 남의 메일 주소로 로그인할 수 있다.
> `infra/docker-compose.prod.yml` 이 이 세 값을 못 박고, 값이 없으면 compose 가 뜨지 않게 한다.
>
> 고치는 순간 `AUTH_SECRET` 이 바뀌므로 **기존 로그인 세션은 모두 끊긴다.** 의도된 결과다.

### 🔴 nginx 공용 CSP 가 명함 인식을 막는다 (2026-10-24)

"사진 인식이 35% 에서 멈춘다" 의 원인이다. 운영 응답에는 `Content-Security-Policy` 가
**두 개** 내려온다 — 앱이 보내는 것(`apps/web/next.config.ts`)과
`/etc/nginx/snippets/ckp-security.conf` 가 붙이는 공용 정책. 브라우저는 CSP 가 여러 개면
**교집합**을 강제하므로 공용 쪽이 빠뜨린 것이 전부 금지된다.

```bash
curl -skI --resolve linkos.ckp.kr:443:127.0.0.1 https://linkos.ckp.kr/app/scan | grep -ci '^content-security-policy'
# 2  ← nginx 가 하나 더 붙인다 (컨테이너 직접 조회는 1)
```

공용 정책의 `script-src` 에 **`'wasm-unsafe-eval'` 이 없다** → WebAssembly 가 통째로
막힌다 → tesseract.js 도 PP-OCRv5 도 못 돈다. 진행률 0.35 는 "언어 데이터 불러오는 중"
이 끝나는 지점이라 거기서 굳는다. `connect-src` 에 tessdata·jsDelivr 가 없어 언어 데이터도
못 받고, `camera=()` 가 앱의 `camera=(self)` 를 덮어 카메라 권한도 함께 막힌다.

고치는 방법은 linkos vhost 에서 그 include 를 빼는 것이다. 앱이 이미 완전한 보안 헤더
묶음을 보내고 있어, 빼면 오히려 대부분 더 엄격해진다.

| 헤더 | 앱(Next) | 공용 스니펫 | include 제거 시 |
|---|---|---|---|
| CSP `script-src` | `'wasm-unsafe-eval'` 있음 | 없음 | **OCR 이 돌게 된다** |
| CSP `connect-src` | jsDelivr·tessdata 허용 | `'self'` + CF 만 | tesseract 폴백이 살아난다 |
| CSP `frame-ancestors` | `'none'` | `'self'` | 더 엄격 |
| CSP `img-src` | `'self' data: blob:` | `https:` 전부 | 더 엄격 |
| `X-Frame-Options` | `DENY` | `SAMEORIGIN` | 더 엄격 |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=()` | `camera=(), microphone=(), geolocation=(self)` | 카메라·마이크 허용(제품 기능), 위치는 더 엄격 |
| `Strict-Transport-Security` | `63072000; includeSubDomains; preload` | `31536000; includeSubDomains` | 더 강함 |
| `X-Content-Type-Options`·`Referrer-Policy` | 동일 | 동일 | 변화 없음 |

```bash
ssh ckp 'cp /etc/nginx/sites-available/linkos-kr{,.bak} \
  && sed -i "s|^\( *\)include snippets/ckp-security.conf;|\1# 보안 헤더는 앱이 직접 보낸다 — 공용 CSP 를 함께 붙이면 교집합 때문에 WebAssembly(OCR)가 막힌다\n\1# include snippets/ckp-security.conf;|" /etc/nginx/sites-available/linkos-kr \
  && nginx -t && systemctl reload nginx'
```

다른 사이트가 쓰는 `snippets/ckp-security.conf` 자체는 건드리지 않는다. 적용 뒤:

```bash
curl -sI https://linkos.ckp.kr/app/scan | grep -ci '^content-security-policy'   # 1 이어야 한다
```

앱 쪽은 이 상황에서도 영원히 기다리지 않게 고쳐 두었다 — 시작 전에 WebAssembly 를
컴파일해 보고 막혀 있으면 "기기 내 인식을 쓸 수 없다" 고 바로 알린다(`lib/ocr.ts`).
즉 nginx 를 안 고치면 **인식이 안 되는 것은 그대로이고, 멈춘 채 기다리지만 않는다.**

아직 남은 것(확인만 하고 손대지 않았다):

- `infra/docker-compose.yml` 의 `environment` 블록이 넘기는 키는 9개뿐이다 —
  `ANTHROPIC_*`·`OBJECT_STORAGE_*`·`APPLE_*`·`CLAMAV_*`·`STT_*` 는 `.env` 에 있어도
  컨테이너에 닿지 않는다. 그래서 헬스체크 응답에 `ai` 항목이 아예 없다(AI 가 꺼져 있다).
  `env_file: [../.env]` 를 prod 오버레이에 넣으면 한 번에 해결되지만,
  `CLAMAV_REQUIRED` 처럼 켜지는 순간 업로드를 막는 값이 있어 값을 확인한 뒤에 해야 한다.
- `infra-worker-1` 이 계속 `unhealthy` 다. Dockerfile 의 `HEALTHCHECK` 가 `/api/v1/health` 를
  때리는데 워커는 웹 서버를 띄우지 않는다 — 워커에는 헬스체크를 두지 않거나 다른 검사를 써야 한다.
- `revision` 이 `null` 이다. `APP_REVISION` 을 빌드 인자로 넣으면 지금 떠 있는 빌드가
  어느 커밋인지 헬스체크로 확인할 수 있다.

## 자동 배포 (GitHub Actions)

`.github/workflows/deploy-ckp.yml` 이 **main 의 CI 가 통과한 커밋**을 그대로 배포하고, 공개 주소의
`/api/v1/health` 가 그 커밋의 `revision` 을 보고하는지까지 확인한다. 아래 시크릿이 없으면 건너뛴다(실패 아님).
수동 실행: Actions → *Deploy (linkos.ckp.kr)* → Run workflow (ref 지정 가능).

최초 1회 설정 (서버에서):

```bash
# 1) 배포 전용 키 — 이 키로는 배포 스크립트 실행 외에 아무것도 할 수 없다
ssh-keygen -t ed25519 -N '' -C github-actions-linkos -f /root/linkos_deploy_key
install -m 755 /var/www/linkos/infra/ckp/linkos-deploy-ssh.sh /usr/local/bin/linkos-deploy-ssh
echo "restrict,command=\"/usr/local/bin/linkos-deploy-ssh\" $(cat /root/linkos_deploy_key.pub)" >> /root/.ssh/authorized_keys
cat /root/linkos_deploy_key          # → GitHub 시크릿 CKP_SSH_KEY 에 붙여 넣은 뒤 서버에서 삭제
rm /root/linkos_deploy_key /root/linkos_deploy_key.pub
```

GitHub → 저장소 Settings → Secrets and variables → Actions → New repository secret:

| 이름 | 값 |
|---|---|
| `CKP_SSH_KEY` | 위 개인키 전체 |
| `CKP_SSH_HOST` | `1.234.5.14` |
| `CKP_SSH_KNOWN_HOSTS` | 서버에서 `ssh-keyscan -t ed25519 localhost \| sed 's/^localhost/1.234.5.14/'` 출력 (서버 자신의 호스트 키) |
| `CKP_SSH_USER` | (선택) 기본 `root` |

설정 후 main 에 머지될 때마다 자동 배포된다. 실패하면 Actions 로그와 서버의 `journalctl -t linkos-deploy` 를 본다.

## AI (Anthropic)

`/etc/linkos/linkos.env` 에 `ANTHROPIC_API_KEY` 와 `ANTHROPIC_WORKSPACE_ID` 가 들어 있다.
**모델은 지정하지 않는다** — 호출 종류마다 티어가 있고(`packages/domain/src/llmRouting.ts`),
티어를 만족하는 가장 싼 계열의 최신 모델을 Models API 로 찾아 쓴다(6시간 캐시).
새 모델이 나오면 캐시가 만료되는 순간 자동으로 옮겨탄다 — 배포가 필요 없다.
지금 무엇이 쓰이는지는 위 헬스체크의 `ai.models` 로 확인한다.

| 호출 | 티어 | 모델(현재) |
|---|---|---|
| `profile_summary` · `room_summary` · `schedule_hint` | cheap | Haiku |
| `followup_draft` · `intro_draft` · `translate` · `adaptive_card` · `meeting_extract` | standard | Sonnet |

- ⚠️ **워크스페이스 ID 가 필요한 이유**: 지금 키는 워크스페이스에 스코프되지 않은 유형이라
  `anthropic-workspace-id` 헤더가 없으면 **모든 요청이 400** 이다. 콘솔에서 워크스페이스
  전용 키(`sk-ant-api…`)를 발급받아 바꾸면 `ANTHROPIC_WORKSPACE_ID` 는 지워도 된다.
- 특정 모델로 고정해야 하면 `LLM_MODEL`(전체) 또는 `LLM_MODEL_CHEAP`/`_STANDARD`/`_DEEP`.
  AI 를 통째로 끄려면 `LLM_DISABLED=1` — 모든 기능이 규칙 기반 폴백으로 조용히 동작한다.
- 비용은 `cost_ledger` 에 **계열별 요율**로 쌓인다(`llm.input_token.haiku` 등). 같은 토큰
  수라도 Haiku 와 Sonnet 이 20배 차이 나므로, 하나의 평균 요율로는 라우팅 효과가 안 보인다.

## 이 서버에서만 다른 점 (반드시 유지)

1. **공통 nginx 스니펫을 include 하지 않는다.**
   `snippets/ckp-security.conf` 의 CSP 는 `camera=()`·`microphone=()` 이고 `wasm-unsafe-eval`·
   `worker-src blob:`·`cdn.jsdelivr.net` 이 없다. LINKOS 는 `apps/web/next.config.ts` 에서
   자기 CSP 를 직접 내려보내는데, 헤더가 둘이면 브라우저는 **교집합**을 적용한다.
   include 하는 순간 명함 촬영(`/app/scan`)·미팅 녹음·기기 내 OCR 이 전부 막힌다.
2. **포트 4300.** 3000(ckp-backend)·4000·4010·4100·4110·4200·4210·8000·8010·8020·8030·13000 은 이미 쓰고 있다.
3. **레이트리밋은 전용 존 `linkos_api`(30r/s).** 공통 `ckp_api` 는 10r/s 라 화면 한 장이 API 를
   여러 번 부르는 LINKOS 에서는 정상 사용이 429 가 된다. 세밀한 제한은 앱이 직접 한다.
4. **pgvector 는 소스 빌드로 넣었다.** Ubuntu 22.04 apt 에 `postgresql-14-pgvector` 가 없어
   `make`·`postgresql-server-dev-14` 를 깔고 pgvector v0.8.0 을 컴파일했다
   (`db/migrations/0001` 의 `CREATE EXTENSION vector` 를 원본 그대로 두기 위해서다).
   PostgreSQL 을 메이저 업그레이드하면 **다시 컴파일해야 한다.**
5. **메일은 로컬 postfix → Gmail 릴레이**(`SMTP_URL=smtp://127.0.0.1:25`).
   `sender_canonical_maps` 가 발신자를 다시 쓰므로 `MAIL_FROM` 은 ckp.kr 주소를 쓴다.
6. **빌드 피크 RSS 가 약 1.9GB** 인데 이 서버의 가용 RAM 은 약 1.4GB 다. swap(3.7GB)으로 버틴다.
   배포 스크립트가 `NODE_OPTIONS=--max-old-space-size=2048` 을 건다. 다른 서비스가 메모리를
   많이 쓰는 시간대의 배포는 피하는 게 좋다.

## 테스트 계정 (지금 켜져 있음)

`DEMO_LOGIN=1` 이라 `/login` 에 **"테스트 계정으로 바로 시작"** 이 보인다. 한 번 누르면 일회용
계정이 생기고 메일은 오가지 않는다. 공개 주소이므로 누구나 누를 수 있다 — 실사용 전환 시 끄자.

```bash
ssh ckp "sed -i 's/^DEMO_LOGIN=1/DEMO_LOGIN=0/' /etc/linkos/linkos.env && systemctl restart linkos-web"
```

## 최초 설치 (복구용 기록)

```bash
# 1) 소스
mkdir -p /var/www/linkos && git clone --depth=1 https://github.com/sooasim/linkos.git /var/www/linkos

# 2) pgvector (apt 에 없어 소스 빌드)
apt-get install -y make postgresql-server-dev-14
git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector
cd /tmp/pgvector && make && make install

# 3) DB
openssl rand -base64 24 | tr -d '/+=' | head -c 28 > /etc/linkos/db_password
su - postgres -c "/usr/lib/postgresql/14/bin/psql -c \"CREATE ROLE linkos LOGIN PASSWORD '...'\""
su - postgres -c "/usr/lib/postgresql/14/bin/psql -c 'CREATE DATABASE linkos OWNER linkos'"
su - postgres -c "/usr/lib/postgresql/14/bin/psql -d linkos -c 'CREATE EXTENSION pgcrypto; CREATE EXTENSION vector'"

# 4) 설정 — /etc/linkos/linkos.env (AUTH_SECRET·CREDENTIALS_KEY 는 서버에서 생성해 밖으로 내보내지 않는다)
#    openssl rand -base64 48 / openssl rand -base64 32

# 5) 서비스 사용자·디렉터리
useradd --system --no-create-home --shell /usr/sbin/nologin linkos
mkdir -p /var/lib/linkos/storage && chown -R linkos:linkos /var/lib/linkos && chmod 700 /var/lib/linkos/storage

# 6) 유닛·vhost
cp infra/ckp/linkos-web.service infra/ckp/linkos-worker.service /etc/systemd/system/
cp infra/ckp/linkos.conf /etc/nginx/conf.d/linkos.conf
cp infra/ckp/linkos-kr.nginx /etc/nginx/sites-available/linkos-kr
ln -s /etc/nginx/sites-available/linkos-kr /etc/nginx/sites-enabled/
systemctl daemon-reload && systemctl enable --now linkos-web linkos-worker
nginx -t && systemctl reload nginx

# 7) 첫 배포
bash /var/www/linkos/scripts/deploy-ckp.sh
```

DNS 는 Cloudflare(zone `ckp.kr`)에 `linkos` A → `1.234.5.14`, **Proxied ON**.

## 점검

```bash
ssh ckp 'systemctl status linkos-web linkos-worker --no-pager | head -20'
ssh ckp 'journalctl -u linkos-web -n 50 --no-pager'
ssh ckp 'journalctl -u linkos-worker -n 50 --no-pager'
curl -s https://linkos.ckp.kr/api/v1/health
```
