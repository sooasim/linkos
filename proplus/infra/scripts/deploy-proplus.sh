#!/usr/bin/env bash
# PROPLUS 재배포 — proplus.linkos.com  (P-190, 전략 §10)
# 서버: cafe24 1.234.5.14 (hostname ckp24.cafe24.com), Ubuntu 22.04 + nginx + PostgreSQL 14
#
#   서버에서:  bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh [git-ref]
#   로컬에서:  ssh ckp 'bash /var/www/proplus/proplus/infra/scripts/deploy-proplus.sh'
#
# 멱등하다. 소스 갱신 → 설치 → 빌드 → 정적 자산 배치 → 마이그레이션 → 재시작 → 헬스체크 순이고,
# **빌드가 끝난 뒤에만 재시작**하므로 어느 단계에서 실패해도 이전 빌드가 계속 서비스된다.
# 최초 1회 설치(사용자·DB·유닛·vhost·인증서)는 proplus/docs/03_DEPLOY.md 를 따른다.
#
# ⚠️ 이 스크립트는 LINKOS 를 건드리지 않는다. 체크아웃(/var/www/linkos ↔ /var/www/proplus),
#    DB(linkos ↔ proplus), 유닛(linkos-* ↔ proplus-*), 설정(/etc/linkos ↔ /etc/proplus)이
#    모두 다르다. linkos-* 유닛을 재시작하는 줄을 여기에 추가하지 말 것 (전략 §1 배포 격리).
set -euo pipefail

REF="${1:-origin/main}"
APP_DIR=/var/www/proplus
ENV_FILE=/etc/proplus/proplus.env
NODE_BIN=/opt/node24/bin
PORT=4400
# 워크스페이스 루트 기준 @proplus/web 의 위치. standalone 출력도 이 상대경로를 그대로 재현한다.
WEB_PKG_DIR=proplus/apps/web

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# 아래 `git reset --hard` 는 이 스크립트 파일 자체도 갈아치운다. 대상 ref 에 이 파일이
# 없으면(아직 머지되지 않은 브랜치 ↔ main 을 오갈 때) 실행 도중 사라져서
# "No such file or directory" 로 죽는다. bash 는 스크립트를 조금씩 읽어 들이기 때문이다.
# 저장소 안에서 실행됐다면 /tmp 복사본으로 다시 실행해 체크아웃과 분리한다.
case "$0" in
  "$APP_DIR"/*)
    _self="$(mktemp /tmp/proplus-deploy.XXXXXX.sh)"
    cp "$0" "$_self"
    exec bash "$_self" "$@"
    ;;
  /tmp/proplus-deploy.*) trap 'rm -f "$0"' EXIT ;;
esac

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — 최초 설치는 proplus/docs/03_DEPLOY.md 를 보세요" >&2; exit 1; }

export PATH="$NODE_BIN:$PATH"
export NEXT_TELEMETRY_DISABLED=1
# 이 서버는 RAM 3GB(가용 ~1.4GB) + swap 3.7GB 다. Next 빌드 피크 RSS 가 약 1.9GB 라
# 상한을 두지 않으면 OOM 으로 죽을 수 있다. LINKOS 빌드와 겹치는 시간대는 피한다.
export NODE_OPTIONS=--max-old-space-size=2048

log "소스 갱신 ($REF)"
cd "$APP_DIR"
# 서버의 체크아웃은 main 만 가진 shallow clone 이라 다른 브랜치의 원격 추적 ref 가 없다.
# 방금 받은 FETCH_HEAD 를 그대로 쓰면 브랜치·태그·SHA 어느 쪽을 넘겨도 똑같이 동작한다.
git fetch --depth=1 origin "${REF#origin/}"
git reset --hard FETCH_HEAD
git log --oneline -1

log "의존성"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@10.28.0 --activate >/dev/null 2>&1
# lockfile 은 LINKOS 와 공유한다(전략 §1 "공유하는 것: pnpm 워크스페이스"). 그래서 필터 설치가
# 아니라 전체 설치를 한다 — --frozen-lockfile 과 --filter 를 섞으면 lockfile 검증 범위가
# 줄어들어 "로컬에선 됐는데 서버에서 다른 버전" 이 생긴다. 디스크를 조금 더 쓰는 쪽을 택했다.
pnpm install --frozen-lockfile

# /api/v1/health 의 revision 이 "지금 떠 있는 빌드가 어느 커밋인가" 를 답하게 한다
# (P-182, buildInfo() 가 APP_REVISION 을 읽는다). 롤백·배포 확인의 1차 근거다.
REVISION="$(git rev-parse HEAD)"
install -d -m 755 /etc/proplus
printf 'APP_REVISION=%s\n' "$REVISION" > /etc/proplus/revision.env
chmod 640 /etc/proplus/revision.env
chown root:proplus /etc/proplus/revision.env
export APP_REVISION="$REVISION"

log "빌드"
# next.config.ts 의 headers() 가 빌드 시점 환경변수를 읽으므로 .env 를 먼저 적용한다
# (CSP — N-10 미니사이트 사용자 JS 금지를 헤더로 강제한다).
set -a; . "$ENV_FILE"; set +a
pnpm --filter @proplus/web build

# standalone 출력에는 .next/static 과 public 이 들어 있지 않다(Dockerfile 과 동일하게 복사한다).
log "정적 자산 배치"
STANDALONE="$APP_DIR/$WEB_PKG_DIR/.next/standalone/$WEB_PKG_DIR"
if [ ! -f "$STANDALONE/server.js" ]; then
  # 모노레포에서 standalone 출력 경로는 next.config.ts 의 outputFileTracingRoot 에 달려 있다.
  # 경로가 다르면 systemd 의 WorkingDirectory/ExecStart 도 함께 틀리므로 여기서 멈춘다.
  echo "standalone 출력을 찾지 못했다: $STANDALONE/server.js" >&2
  echo "next.config.ts 의 output:'standalone' · outputFileTracingRoot 를 확인하세요" >&2
  exit 1
fi
rm -rf "$STANDALONE/.next/static" "$STANDALONE/public"
mkdir -p "$STANDALONE/.next"
cp -r "$APP_DIR/$WEB_PKG_DIR/.next/static" "$STANDALONE/.next/static"
cp -r "$APP_DIR/$WEB_PKG_DIR/public" "$STANDALONE/public"

log "마이그레이션"
# proplus DB 전용 러너. advisory lock 727275 를 쓴다(LINKOS 는 727274) — 두 배포가 겹쳐도
# 서로를 막지 않고, PROPLUS 배포가 두 번 겹치면 뒤쪽이 기다린다 (P-181).
node_modules/.bin/tsx proplus/services/api/src/migrate.ts

# 런타임은 proplus 사용자로 돈다. 빌드는 root 로 했으므로 읽기 권한을 보장한다.
chown -R root:proplus "$APP_DIR/$WEB_PKG_DIR/.next" "$APP_DIR/node_modules" 2>/dev/null || true
chmod -R a+rX "$APP_DIR/$WEB_PKG_DIR/.next" 2>/dev/null || true

log "서비스 재시작"
systemctl restart proplus-web.service
systemctl restart proplus-worker.service

log "헬스체크"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
    curl -sS "http://127.0.0.1:$PORT/api/v1/health"; echo
    log "배포 완료 — https://proplus.linkos.com"
    exit 0
  fi
  sleep 2
done

echo "헬스체크 실패 — 최근 로그:" >&2
journalctl -u proplus-web.service -n 40 --no-pager >&2
exit 1
