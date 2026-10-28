/**
 * CSRF 방어용 origin 검사 — P-188 (보안정책 §2 / 데이터모델 §5).
 *
 * 왜 토큰이 아니라 origin 인가:
 *   세션 쿠키가 `sameSite=lax` 라 교차 사이트 POST 에는 쿠키가 실리지 않는다(P-002).
 *   그 위에 origin 검사를 더하면 토큰을 모든 폼에 심지 않고도 변경 요청을 막을 수 있다.
 *   브라우저는 `Origin` 헤더를 **스크립트가 위조할 수 없게** 붙인다 — 그게 이 검사의 근거다.
 *
 * `Referer` 를 보지 않는 이유: 프라이버시 설정·프록시가 흔히 지워서 정상 요청이 깨진다.
 */

/**
 * 이 요청을 변경 작업으로 받아들여도 되는가.
 *
 * `origin` 이 없으면 통과시킨다 — 서버 간 호출·curl·모바일 클라이언트에는 Origin 이 없고,
 * 그들에게는 애초에 브라우저 쿠키가 자동으로 실리지 않으므로 CSRF 가 성립하지 않는다.
 * 이 경로를 막으면 CSRF 가 아니라 인증 문제로 거절해야 할 요청을 403 으로 숨기게 된다.
 *
 * @param origin   요청의 `Origin` 헤더 (없으면 null)
 * @param host     요청의 `Host` 헤더. 리버스 프록시 뒤에서도 nginx 가 그대로 넘긴다
 * @param appOrigin 설정된 공식 주소 (운영: https://proplus.linkos.com — 전략 §10)
 */
export function isAllowedOrigin(origin: string | null, host: string | null, appOrigin?: string): boolean {
  const raw = origin?.trim();
  if (!raw) return true;

  // "null" 은 sandbox iframe·data: 문서가 보내는 값이다. 우리 화면이 아니다.
  if (raw === "null") return false;

  const originHost = hostOf(raw);
  if (!originHost) return false;

  if (appOrigin) {
    // 스킴까지 비교한다. 호스트만 보면 `http://proplus.linkos.com` 이
    // `https://proplus.linkos.com` 설정을 통과하고, 그 평문 페이지는 중간자가
    // 내용을 바꿀 수 있으므로 "스크립트가 위조할 수 없는 Origin" 이라는 이 검사의
    // 전제가 무너진다. appOrigin 이 주어진 경우에는 origin 전체가 일치해야 한다.
    const appFull = originOf(appOrigin);
    if (appFull) return appFull === originOf(raw);
  }

  // appOrigin 이 **설정되지 않은 환경**(로컬 개발, 프리뷰 배포)에서만 Host 헤더로 판정한다.
  // Host 는 요청이 실제로 도달한 대상이고 브라우저가 붙이므로, origin 과 같으면 같은 사이트다.
  // 다만 Host 에는 스킴이 없어 http/https 를 구분할 수 없다 — 그래서 운영에서는 appOrigin 을
  // 반드시 설정한다(infra/scripts/deploy-proplus.sh 가 APP_ORIGIN 을 요구한다).
  const h = normalizeHost(host);
  if (h && h === originHost) return true;

  return false;
}

/** 비교 가능한 `scheme://host:port`. 스킴이 http/https 가 아니면 null. */
function originOf(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

/** origin 문자열에서 비교 가능한 `host:port` 를 뽑는다. 스킴이 http/https 가 아니면 거절한다. */
function hostOf(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // `URL.host` 는 기본 포트(80/443)를 생략하므로 Host 헤더와 그대로 비교된다.
  return u.host.toLowerCase();
}

function normalizeHost(host: string | null): string | null {
  const h = host?.trim().toLowerCase();
  return h ? h : null;
}
