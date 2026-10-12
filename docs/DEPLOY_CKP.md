# LINKOS 배포 런북 — linkos.ckp.kr

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
# {"status":"ok","db":"ok","migrations":18,"version":"1.0.0","revision":"a093b27"}
```

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
