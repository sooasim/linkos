#!/usr/bin/env bash
# LINKOS 재배포 — linkos.ckp.kr (cafe24 1.234.5.14, Ubuntu 22.04 + nginx + PostgreSQL 14)
#
#   서버에서:  bash /var/www/linkos/scripts/deploy-ckp.sh [git-ref]
#   로컬에서:  ssh ckp 'bash /var/www/linkos/scripts/deploy-ckp.sh'
#
# 멱등하다. 어느 단계에서 실패해도 이전 빌드가 계속 서비스된다(빌드가 끝난 뒤에만 재시작).
# 최초 1회 설치(사용자·DB·유닛·vhost)는 docs/DEPLOY_CKP.md 를 따른다.
set -euo pipefail

REF="${1:-origin/main}"
APP_DIR=/var/www/linkos
ENV_FILE=/etc/linkos/linkos.env
NODE_BIN=/opt/node24/bin
PORT=4300

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — 최초 설치는 docs/DEPLOY_CKP.md 를 보세요" >&2; exit 1; }

export PATH="$NODE_BIN:$PATH"
export NEXT_TELEMETRY_DISABLED=1
# 이 서버는 RAM 3GB(가용 ~1.4GB) + swap 3.7GB 다. Next 빌드 피크 RSS 가 약 1.9GB 라
# 상한을 두지 않으면 OOM 으로 죽을 수 있다.
export NODE_OPTIONS=--max-old-space-size=2048

log "소스 갱신 ($REF)"
cd "$APP_DIR"
# 서버의 체크아웃은 main 만 가진 shallow clone 이라 다른 브랜치의 원격 추적 ref
# (refs/remotes/origin/<branch>)가 없다. 방금 받은 FETCH_HEAD 를 그대로 쓰면
# 브랜치·태그·SHA 어느 쪽을 넘겨도 똑같이 동작한다.
git fetch --depth=1 origin "${REF#origin/}"
git reset --hard FETCH_HEAD
git log --oneline -1

log "의존성"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@10.28.0 --activate >/dev/null 2>&1
pnpm install --frozen-lockfile

# /api/v1/health 의 revision 이 "지금 떠 있는 빌드가 어느 커밋인가" 를 답하게 한다
# (platform.buildInfo() 가 APP_REVISION 을 읽는다). 롤백·배포 확인의 1차 근거다.
REVISION="$(git rev-parse HEAD)"
printf 'APP_REVISION=%s\n' "$REVISION" > /etc/linkos/revision.env
chmod 640 /etc/linkos/revision.env
chown root:linkos /etc/linkos/revision.env
export APP_REVISION="$REVISION"

log "빌드"
# next.config.ts 의 headers() 가 빌드 시점 환경변수를 읽으므로 .env 를 먼저 적용한다
# (CSP_EXTRA_SCRIPT_SRC 등).
set -a; . "$ENV_FILE"; set +a
pnpm --filter @linkos/web build

# standalone 출력에는 .next/static 과 public 이 들어 있지 않다(Dockerfile 과 동일하게 복사한다).
log "정적 자산 배치"
STANDALONE="$APP_DIR/apps/web/.next/standalone/apps/web"
rm -rf "$STANDALONE/.next/static" "$STANDALONE/public"
mkdir -p "$STANDALONE/.next"
cp -r "$APP_DIR/apps/web/.next/static" "$STANDALONE/.next/static"
cp -r "$APP_DIR/apps/web/public" "$STANDALONE/public"

log "마이그레이션"
node_modules/.bin/tsx services/api/src/migrate.ts

# 런타임은 linkos 사용자로 돈다. 빌드는 root 로 했으므로 읽기 권한을 보장한다.
chown -R root:linkos "$APP_DIR/apps/web/.next" "$APP_DIR/node_modules" 2>/dev/null || true
chmod -R a+rX "$APP_DIR/apps/web/.next" 2>/dev/null || true

log "서비스 재시작"
systemctl restart linkos-web.service
systemctl restart linkos-worker.service

log "헬스체크"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
    curl -sS "http://127.0.0.1:$PORT/api/v1/health"; echo
    log "배포 완료 — https://linkos.ckp.kr"
    exit 0
  fi
  sleep 2
done

echo "헬스체크 실패 — 최근 로그:" >&2
journalctl -u linkos-web.service -n 40 --no-pager >&2
exit 1
