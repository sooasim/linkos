# PROPLUS 배포 런북 — proplus.linkos.com  (P-190)

LINKOS 와 **같은 서버, 다른 모든 것**. 운영 중인 공용 서버(cafe24 `1.234.5.14`, hostname
`ckp24.cafe24.com`)에는 LINKOS(`linkos.ckp.kr`)와 ckp.kr·pt·link·woori·kakao·pay·bu 등이
**이미 돌고 있다.** 아래 전제를 깨지 말 것 (`docs/DEPLOY_CKP.md` 와 함께 읽는다).

---

## ⚠️ 선행 조건 — 이것이 해결되기 전에는 `proplus.linkos.com` 이 뜨지 않는다

코드로 해결할 수 없는 세 가지다. 지금 **셋 다 미해결**이다.

| # | 조건 | 현재 상태 |
|---|---|---|
| 1 | **`linkos.com` 도메인 소유** | 미정. 문서 세트 *미결정사항 §2* 에 "PROPLUS 상표 및 도메인 확보 여부"가 미정으로 적혀 있다 |
| 2 | **TLS 인증서** — `*.linkos.com` Cloudflare Origin 인증서 또는 Let's Encrypt 발급 | 없음. 기존 `/etc/ssl/ckp/pt.pem` 은 Cloudflare Origin 와일드카드 **`*.ckp.kr`** 이라 `proplus.linkos.com` 을 **덮지 않는다** |
| 3 | **DNS** — `proplus.linkos.com` A/CNAME → `1.234.5.14` (Cloudflare 프록시 권장) | 없음 (1번에 종속) |

vhost 는 처음부터 `/etc/ssl/proplus/proplus.pem`·`proplus.key` 를 참조하도록 써 두었다.
인증서가 발급되면 **vhost 파일을 고치지 않고 그 두 파일만 교체**하면 된다.

### 선행 조건 미해결 동안의 임시 확인 경로 — `proplus.ckp.kr`

vhost 의 `server_name` 에 두 이름(`proplus.linkos.com proplus.ckp.kr`)을 함께 두었다.
`proplus.ckp.kr` 은 **기존 `*.ckp.kr` 와일드카드 인증서가 덮으므로 즉시 확인 가능**하다.

```bash
# 인증서 경로를 기존 ckp 와일드카드로 부트스트랩 (나중에 교체할 때 vhost 를 안 건드리기 위해 심링크)
install -d -m 755 /etc/ssl/proplus
ln -sfn /etc/ssl/ckp/pt.pem /etc/ssl/proplus/proplus.pem
ln -sfn /etc/ssl/ckp/pt.key /etc/ssl/proplus/proplus.key
# DNS: Cloudflare zone ckp.kr 에 proplus A → 1.234.5.14, Proxied ON
```

이 상태에서 `https://proplus.ckp.kr` 은 정상이고 `https://proplus.linkos.com` 은
**TLS 이름 불일치로 실패한다** — 정상이다. 선행 조건 2가 끝나면 심링크를 실제 인증서로 바꾼다.

```bash
# 인증서 발급 후 (예: Cloudflare Origin *.linkos.com)
install -m 644 linkos-origin.pem /etc/ssl/proplus/proplus.pem
install -m 600 linkos-origin.key /etc/ssl/proplus/proplus.key
nginx -t && systemctl reload nginx
```

> nginx 는 SNI 로 인증서를 고르지 못한다(`ssl_certificate` 는 서버 블록당 하나, 키 타입별로만 복수).
> 그래서 두 이름을 한 블록에 두고 **인증서 파일 경로를 간접화**했다. 두 이름 각각에 다른
> 인증서를 쓰려면 서버 블록을 쪼개야 하고, 그러면 `conflicting server name` 경고가 난다.

---

## 배치

> **2026-10-24 실배포로 확인한 사실.** 이 문서의 초안은 구서버(`1.234.5.14`, cafe24 ckp24) 기준이었다.
> 그 서버는 **2026-10-16 에 회수됐다**(죽음). 아래는 실제로 배포해 동작을 확인한 현재 서버 기준이다.
>
> | | 초안(구서버) | **실제(현재)** |
> |---|---|---|
> | 호스트 | 1.234.5.14 / ckp24.cafe24.com | **1.234.82.36 / qm391-1139** (`ssh ckp`) |
> | 인증서 | Cloudflare Origin `*.ckp.kr` (2041) | **Let's Encrypt 와일드카드** `/etc/letsencrypt/live/ckp.kr/` (90일 자동갱신) |
> | 시스템 node | v20 | **v24.22 + npm 11** (`/usr/bin/node`). `/opt/node24/bin` 에는 `node` 하나뿐이라 npm·pnpm 이 없다 |
> | pnpm | 있다고 가정 | **없다 — `npm i -g pnpm@10.28.0` 이 최초 1회 필요** |
> | LINKOS | 같은 서버에서 운영 중(4300) | **아직 미이전.** `/var/www/linkos` 없음, `linkos-kr` vhost 만 남아 있다 |
> | RAM | 3GB(가용 1.4GB) | **32GB** — 빌드 메모리 상한을 걱정할 필요가 없다 |
> | nginx 레이트리밋 키 | 공통 `$ckp_client_ip` | **그 변수는 이 서버에 없다.** `proplus-http.conf` 가 자기 `map` 으로 정의한다 |

| 항목 | 값 |
|---|---|
| 주소 | https://proplus.linkos.com (임시: https://proplus.ckp.kr) |
| 소스 | `/var/www/proplus` (GitHub `sooasim/linkos` 얕은 clone — LINKOS 체크아웃과 **별도 디렉터리**) |
| 런타임 | `/opt/node24/bin/node` (v24). 시스템 node 도 v24 이지만 유닛은 경로를 고정해 둔다 |
| 웹/API | `proplus-web.service` → `127.0.0.1:4400` (루프백 전용, 유닛이 `HOSTNAME=127.0.0.1` 을 못 박는다) |
| 워커 | `proplus-worker.service` (outbox·만료 알림) |
| DB | 기존 PostgreSQL 14 클러스터의 **`proplus` DB / `proplus` 롤** (LINKOS 의 `linkos` DB 와 분리) |
| 설정 | `/etc/proplus/proplus.env` (root:proplus 640) |
| 업로드 | `/var/lib/proplus/storage` (증거 원본 — N-5) |
| vhost | `/etc/nginx/sites-available/proplus` + `/etc/nginx/conf.d/proplus.conf` |
| 인증서 | `/etc/ssl/proplus/proplus.pem`·`proplus.key` (위 선행 조건 2) |

저장소 파일 → 서버 경로

| 저장소 | 서버 |
|---|---|
| `proplus/infra/nginx/proplus.linkos.com.conf` | `/etc/nginx/sites-available/proplus` |
| `proplus/infra/nginx/proplus-http.conf` | `/etc/nginx/conf.d/proplus.conf` |
| `proplus/infra/systemd/proplus-web.service` | `/etc/systemd/system/proplus-web.service` |
| `proplus/infra/systemd/proplus-worker.service` | `/etc/systemd/system/proplus-worker.service` |
| `proplus/.env.example` | `/etc/proplus/proplus.env` 작성의 출발점 |

---

## 재배포

```bash
ssh ckp 'bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh'      # 기본 origin/main
ssh ckp 'bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh my-branch'
```

멱등하다. **소스 갱신 → 설치 → 빌드 → 정적 자산 배치 → 마이그레이션 → 재시작 → 헬스체크** 순이고,
빌드가 끝난 뒤에야 재시작하므로 중간에 실패하면 **이전 빌드가 계속 서비스된다.**

배포가 실제로 바뀌었는지는 `revision` 으로 확인한다 (P-182).

```bash
ssh ckp 'curl -s http://127.0.0.1:4400/api/v1/health'
curl -s https://proplus.ckp.kr/api/v1/health      # 외부 경로 (선행 조건 2 해결 전 임시 주소)
```

> 자동 배포(GitHub Actions)는 **아직 없다.** LINKOS 는 `.github/workflows/deploy-ckp.yml` 로
> main CI 통과 커밋을 자동 배포하지만, PROPLUS 용 워크플로는 이번 범위에 포함하지 않았다.
> 추가할 때는 LINKOS 와 **다른 배포 전용 키**를 쓰고 `linkos-deploy-ssh` 와 별개의
> forced command 를 둘 것 — 한 키로 두 제품을 배포하면 격리가 깨진다.

---

## 최초 설치

```bash
# 1) 소스 — LINKOS 체크아웃과 별도 디렉터리에 둔다
mkdir -p /var/www/proplus
git clone --depth=1 https://github.com/sooasim/linkos.git /var/www/proplus

# 2) DB — 기존 PostgreSQL 14 클러스터에 proplus 롤/DB 를 새로 만든다 (linkos DB 는 건드리지 않는다)
PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
su - postgres -c "/usr/lib/postgresql/14/bin/psql -c \"CREATE ROLE proplus LOGIN PASSWORD '$PW'\""
su - postgres -c "/usr/lib/postgresql/14/bin/psql -c 'CREATE DATABASE proplus OWNER proplus'"
# 0001 마이그레이션이 요구하는 확장. 모두 postgresql-contrib-14 에 들어 있다(소스 빌드 불필요 —
# LINKOS 의 pgvector 와 다르다). pgcrypto=gen_random_uuid, btree_gist=P-122 예약 겹침 배타제약,
# pg_trgm=P-150 검색 폴백.
su - postgres -c "/usr/lib/postgresql/14/bin/psql -d proplus -c 'CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gist; CREATE EXTENSION pg_trgm'"

# 3) 서비스 사용자·디렉터리
useradd --system --no-create-home --shell /usr/sbin/nologin proplus
mkdir -p /var/lib/proplus/storage
chown -R proplus:proplus /var/lib/proplus && chmod 700 /var/lib/proplus/storage

# 4) 설정 — /etc/proplus/proplus.env (proplus/.env.example 참고)
#    AUTH_SECRET·FIELD_KEY·STORAGE_SIGNING_KEY 는 **서버에서 생성해 밖으로 내보내지 않는다**.
install -d -m 755 /etc/proplus
cat > /etc/proplus/proplus.env <<EOF
NODE_ENV=production
DATABASE_URL=postgres://proplus:$PW@127.0.0.1:5432/proplus
APP_ORIGIN=https://proplus.linkos.com
AUTH_SECRET=$(openssl rand -base64 48)
FIELD_KEY=$(openssl rand -base64 32)
STORAGE_SIGNING_KEY=$(openssl rand -base64 32)
OBJECT_STORAGE_LOCAL_DIR=/var/lib/proplus/storage
SMTP_URL=smtp://127.0.0.1:25
EOF
chmod 640 /etc/proplus/proplus.env && chown root:proplus /etc/proplus/proplus.env

# 5) 유닛·vhost
cd /var/www/proplus
cp proplus/infra/systemd/proplus-web.service proplus/infra/systemd/proplus-worker.service /etc/systemd/system/
cp proplus/infra/nginx/proplus-http.conf /etc/nginx/conf.d/proplus.conf
cp proplus/infra/nginx/proplus.linkos.com.conf /etc/nginx/sites-available/proplus
ln -s /etc/nginx/sites-available/proplus /etc/nginx/sites-enabled/
systemctl daemon-reload

# 6) 인증서 — 위 "임시 확인 경로" 의 심링크를 먼저 걸어야 nginx -t 가 통과한다
nginx -t && systemctl reload nginx

# 7) 첫 배포 (유닛 enable 은 배포 성공 후에 한다 — 빌드 전 기동 실패 루프를 피한다)
bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh
systemctl enable proplus-web proplus-worker
```

`APP_ORIGIN` 은 선행 조건이 해결되기 전 임시 운영 중이라면 `https://proplus.ckp.kr` 로 둔다 —
공개 프로필 링크·vCard·메일 본문에 그대로 박히는 값이라 실제로 열리는 주소여야 한다.

---

## LINKOS 전제 — 깨면 안 되는 것

1. **포트 4400.** 3000(ckp-backend)·4000·4010·4100·4110·4200·4210·**4300(LINKOS)**·8000·8010·8020·8030·13000 은 이미 쓰고 있다.
2. **공통 nginx 스니펫을 include 하지 않는다.** LINKOS 와 같은 이유다 — 앱이 `next.config.ts` 에서
   자기 CSP 를 직접 내려보내고, 헤더가 둘이면 브라우저가 **교집합**을 적용한다. PROPLUS 의 CSP 는
   N-10(미니사이트에 사용자 JS 금지)을 강제하는 제품 규칙이므로 nginx 가 흔들어서는 안 된다.
3. **레이트리밋은 전용 존 `proplus_api`(20r/s).** 공통 `ckp_api`(10r/s)도, LINKOS 의
   `linkos_api`(30r/s)도 공유하지 않는다 — 한쪽 트래픽이 다른 쪽을 굶기지 않게 버킷을 나눈다.
4. **DB·설정·스토리지·감사로그를 공유하지 않는다.** `proplus` DB / `/etc/proplus` / `/var/lib/proplus`.
   마이그레이션 advisory lock 도 다른 값(727275, LINKOS 는 727274)이라 두 배포가 겹쳐도 서로 막지 않는다.
5. **배포 스크립트는 `linkos-*` 유닛을 재시작하지 않는다.** 그 줄을 추가하지 말 것.
6. **빌드 메모리.** 이 서버 가용 RAM 은 약 1.4GB(+swap 3.7GB)이고 Next 빌드 피크 RSS 는 약 1.9GB 다.
   스크립트가 `NODE_OPTIONS=--max-old-space-size=2048` 을 건다. **LINKOS 배포와 동시에 돌리지 않는다.**
7. **디스크.** `/var/www/proplus` 는 같은 저장소의 두 번째 체크아웃이고 lockfile 을 공유하므로
   `pnpm install` 이 LINKOS 의 의존성까지 받는다(전체 설치를 택한 이유는 스크립트 주석에 있다).
   `node_modules` 가 한 벌 더 생긴다는 뜻이다.
8. **메일은 로컬 postfix → Gmail 릴레이**(`SMTP_URL=smtp://127.0.0.1:25`).
   `sender_canonical_maps` 가 발신자를 다시 쓰므로 `MAIL_FROM` 은 ckp.kr 주소를 쓴다.

---

## 점검

```bash
ssh ckp 'systemctl status proplus-web proplus-worker --no-pager | head -20'
ssh ckp 'journalctl -u proplus-web -n 50 --no-pager'
ssh ckp 'journalctl -u proplus-worker -n 50 --no-pager'
ssh ckp 'curl -s http://127.0.0.1:4400/api/v1/health'
# 4400 이 외부에 열려 있지 않아야 한다 (유닛의 HOSTNAME=127.0.0.1)
ss -ltnp | grep 4400      # 127.0.0.1:4400 만 보여야 한다
```

### 롤백

배포는 커밋 ref 를 인자로 받으므로 되돌리는 것도 같은 스크립트다.

```bash
ssh ckp 'bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh <직전-커밋-SHA>'
```

> **마이그레이션은 되돌아가지 않는다.** 0001 이 뷰·트리거·CHECK 로 비타협 원칙을 강제하므로
> (N-1·N-6·N-7·N-9) 스키마를 내리는 것은 그 강제를 푸는 일이다. 스키마 롤백이 필요하면
> 되돌리는 마이그레이션을 **새 번호로 추가**한다.

---

## 로컬 개발

```bash
docker compose -f proplus/infra/docker-compose.yml up -d db   # Postgres 14, 포트 5433
cp proplus/.env.example proplus/.env                          # 비밀값은 직접 채운다
tsx proplus/services/api/src/migrate.ts
pnpm --filter @proplus/web dev                                # http://localhost:4400
```

LINKOS 로컬 DB(5432)와 포트가 겹치지 않으므로 두 제품을 동시에 띄울 수 있다.

---

## 부록 — 2026-10-24 임시 검증 배포 기록 (proplus.ckp.kr)

실제로 수행한 최초 설치 순서. 멱등하게 다시 돌릴 수 있다.

```bash
# 1) 도구·사용자·디렉터리
ssh ckp 'npm i -g pnpm@10.28.0'
ssh ckp 'useradd --system --home /var/lib/proplus --shell /usr/sbin/nologin proplus
         install -d -o proplus -g proplus -m 750 /var/lib/proplus /var/lib/proplus/storage
         install -d -m 755 /etc/proplus'

# 2) DB — 확장은 superuser 가 만들어야 한다(마이그레이션의 CREATE EXTENSION 은 그 뒤 no-op)
ssh ckp 'sudo -u postgres psql -c "CREATE ROLE proplus LOGIN PASSWORD '"'"'…'"'"'"
         sudo -u postgres createdb -O proplus proplus
         sudo -u postgres psql -d proplus -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;
                                              CREATE EXTENSION IF NOT EXISTS btree_gist;
                                              CREATE EXTENSION IF NOT EXISTS pg_trgm;"'

# 3) /etc/proplus/proplus.env (root:proplus 640) — 항목은 proplus/.env.example
#    AUTH_SECRET·FIELD_KEY·STORAGE_SIGNING_SECRET·ANALYTICS_SALT·VISITOR_SALT 는 openssl rand 로 생성
#    APP_ORIGIN 은 **실제 주소와 정확히 같아야** 한다(스킴 포함) — CSRF origin 검사 기준이다

# 4) 소스 배치 (브랜치 미푸시 상태라 git archive 로 전송했다)
git archive --format=tar HEAD -- ':!dd' ':!docs/screenshots' | gzip > /tmp/proplus-src.tgz
scp /tmp/proplus-src.tgz ckp:/tmp/
ssh ckp 'cd /var/www/proplus && find . -maxdepth 1 -mindepth 1 ! -name node_modules -exec rm -rf {} +
         tar xzf /tmp/proplus-src.tgz'

# 5) 설치·빌드·정적자산·마이그레이션
ssh ckp 'cd /var/www/proplus
         pnpm install --frozen-lockfile --filter "@proplus/web..." --filter "@proplus/api..." --filter "@proplus/domain..."
         set -a; . /etc/proplus/proplus.env; set +a
         pnpm --filter @proplus/web build
         S=proplus/apps/web/.next/standalone/proplus/apps/web
         cp -r proplus/apps/web/.next/static "$S/.next/static"
         chown -R proplus:proplus /var/www/proplus
         node_modules/.bin/tsx proplus/services/api/src/migrate.ts'

# 6) systemd
ssh ckp 'install -m 644 /var/www/proplus/proplus/infra/systemd/proplus-*.service /etc/systemd/system/
         systemctl daemon-reload
         systemctl enable --now proplus-web.service proplus-worker.service'

# 7) nginx — **반드시 nginx -t 통과 후에만 reload** (같은 서버에 다른 사이트가 여럿 있다)
ssh ckp 'install -d -m 755 /etc/ssl/proplus
         ln -sfn /etc/ssl/ckp/pt.pem /etc/ssl/proplus/proplus.pem
         ln -sfn /etc/ssl/ckp/pt.key /etc/ssl/proplus/proplus.key
         cp /var/www/proplus/proplus/infra/nginx/proplus-http.conf      /etc/nginx/conf.d/proplus.conf
         cp /var/www/proplus/proplus/infra/nginx/proplus.linkos.com.conf /etc/nginx/sites-available/proplus-kr
         ln -sfn /etc/nginx/sites-available/proplus-kr /etc/nginx/sites-enabled/proplus-kr
         nginx -t && systemctl reload nginx'
```

### 남은 일 — DNS

`proplus.ckp.kr` 의 **A 레코드가 아직 없다.** 서버·TLS·앱은 전부 준비됐고 오리진에서 200 이 확인됐다.

- Cloudflare zone `ckp.kr` → Type `A`, Name `proplus`, Content **`1.234.82.36`**, Proxied **ON**
- 등록하면 바로 `https://proplus.ckp.kr` 로 열린다(인증서는 와일드카드라 추가 발급 불필요).

⚠️ **DNS 를 붙이기 전에 `DEMO_LOGIN` 을 끌지 결정해야 한다.** 지금은 SMTP 가 없어 매직링크
메일이 나가지 않으므로 검증용으로 `DEMO_LOGIN=1` 이다 — 이 상태로 공개되면 **주소를 아는
누구나 로그인할 수 있다.** 공개 전에 `0` 으로 내리고 `SMTP_URL` 을 채운 뒤
`systemctl restart proplus-web` 한다.

### 검증한 것 (2026-10-24, 오리진 직접 호출)

| 항목 | 결과 |
|---|---|
| `/api/v1/health` | `{"status":"ok","db":"ok","migrations":2}` |
| 마이그레이션 멱등 | 2회차 `database up to date` |
| 시드 멱등 | 2회 연속 성공 (FK 정리 순서 수정이 통했다) |
| 공개 프로필 | 200 · 배지 4개 각각 강도·범위·확인일 표기 |
| **N-9 읽기시점 만료** | `expires_at` 을 과거로 → **워커 없이 즉시** 공개 목록에서 사라짐 |
| **P-085 소속 연동** | 배지 만료일 1년 남은 상태에서 `ended_at` 과거로 → 즉시 사라지고, 복구하면 다시 보임 (0002 마이그레이션) |
| **N-1 DB 우회 차단** | `self_declared`+`verified` 직접 INSERT → CHECK 제약이 거부 |
| **N-1 배지 차단** | verified 아닌 검증으로 배지 INSERT → 트리거가 거부 |
| **N-8 지표 차단** | 근거 빈 문자열·표본 0·기간 역전 → CHECK 가 거부 |
| **N-7 감사로그** | `UPDATE audit_logs` → 트리거가 거부 |
| **N-6 자동 기록** | `verification.verified` ×8, `verification.needs_more_info` ×2 자동 생성 |
| **N-11 동의 분리** | 폼에 체크박스 2개(마케팅 기본 해제, "동의하지 않아도 상담은 진행") |
| **P-102 암호화** | 저장값 `v1:…`, 평문 조회 0건, 응답은 `ve***@example.test` 만 |
| 상담 제출 | 201 + 보존기한 자동 설정 |
| P-112 레이트리밋 | 한도 초과 시 429 + `retry-after: 153` |
| CSP 헤더 | **1개만** 내려감(nginx 중복 없음), `script-src` 에 `unsafe-eval` 없음 |
| 콘솔 오류 | 없음 (하이드레이션 정상) |
| 기존 사이트 | ckp.kr·pt·link·bu·kakao **전부 200 유지** |
