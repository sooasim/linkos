/**
 * P-012: 위험 로그인 탐지 — 새 기기·새 지역 로그인 판정 (보안정책 §2 "계정 탈취" / 전략 §7 identity).
 *
 * 이 파일은 P-012 의 **순수 판정부**다. "기록하고 사용자에게 알린다"는 DB·메일이 필요한 상위 계층의
 * 몫이고(모듈이 `sessions` 이력을 읽어 이 함수에 넘긴다), 여기서는 **무엇이 새것인가**만 결정한다.
 *
 * 왜 도메인인가(전략 §3):
 *   "이 로그인이 수상한가"는 알림을 보낼지 말지를 가르는 판단이다. 너무 민감하면 정상 로그인마다
 *   경보가 울려 사용자가 알림을 꺼 버리고(보안 0), 너무 둔하면 탈취를 놓친다. 그 경계를 순수 함수로
 *   떼어 내 전수 테스트로 고정한다.
 *
 * 입력을 호출부가 주는 이유(I/O 금지):
 *   - 기기: `sessions.user_agent` 는 이미 저장돼 있다. UA 문자열을 받아 여기서 정규화한다.
 *   - 지역: 스키마에 지역이 없다(IP 는 `ip_hash` 로만 남는다 — N-13). 지역 판정은 IP→지역 조회가
 *     필요하고 그건 I/O 다. 그래서 **호출부가 해석한 지역 문자열**을 받고, 없으면(null) 지역 신호는 끈다.
 *     지역 수집이 붙기 전에도 기기 신호는 지금 동작한다.
 */

/** UA 는 공격자가 임의로 늘릴 수 있는 입력이다. 파싱 전에 자른다(저장부의 상한과 별개의 방어). */
const UA_SCAN_MAX = 512;

type Named = { re: RegExp; name: string };

/**
 * 브라우저 판정 — **순서가 중요하다.** Edge 는 UA 에 "Chrome" 을 포함하고, Chrome 은 "Safari" 를
 * 포함한다. 더 구체적인 것을 먼저 본다. 모르면 "기타 브라우저"다(틀린 이름을 지어내지 않는다).
 */
const BROWSERS: readonly Named[] = [
  { re: /\bEdg(?:e|A|iOS)?\//, name: "Edge" },
  { re: /\bOPR\/|\bOpera\//, name: "Opera" },
  { re: /\bSamsungBrowser\//, name: "Samsung Internet" },
  { re: /\bFirefox\/|\bFxiOS\//, name: "Firefox" },
  { re: /\bCriOS\/|\bChrome\//, name: "Chrome" },
  { re: /\bSafari\//, name: "Safari" }, // Chrome 류를 먼저 걸렀으므로 여기 오면 진짜 Safari 다
];

/** OS 판정. iPhone/iPad 를 Mac 보다 먼저(둘 다 "like Mac OS X" 를 포함할 수 있다). */
const PLATFORMS: readonly Named[] = [
  { re: /\bWindows NT\b|\bWindows\b/, name: "Windows" },
  { re: /\biPhone\b/, name: "iPhone" },
  { re: /\biPad\b/, name: "iPad" },
  { re: /\bAndroid\b/, name: "Android" },
  { re: /\bCrOS\b/, name: "ChromeOS" },
  { re: /\bMac OS X\b|\bMacintosh\b/, name: "Mac" },
  { re: /\bLinux\b/, name: "Linux" },
];

function matchName(ua: string, table: readonly Named[]): string | null {
  for (const { re, name } of table) {
    if (re.test(ua)) return name;
  }
  return null;
}

/**
 * P-012(판정) 겸 P-005(세션 목록의 "기기 표시") 용 사람이 읽는 라벨.
 *
 * raw UA 를 화면에 그대로 띄우면 사용자가 "내 기기인지" 판단할 수 없다. "Chrome · Windows" 처럼
 * **브라우저 · OS** 로 줄인다. 버전은 넣지 않는다 — 버전까지 보여 주면 핑거프린팅 표면만 늘고
 * 사용자 판단에는 도움이 안 된다.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (typeof userAgent !== "string" || userAgent.trim() === "") return "알 수 없는 기기";
  const ua = userAgent.slice(0, UA_SCAN_MAX);
  const browser = matchName(ua, BROWSERS) ?? "기타 브라우저";
  const platform = matchName(ua, PLATFORMS);
  return platform ? `${browser} · ${platform}` : browser;
}

/**
 * 비교용 안정 키. **버전을 뺀** `browser/os` 소문자다.
 *
 * 왜 버전을 빼는가: 키에 버전이 들어가면 브라우저가 자동 업데이트될 때마다 "새 기기"가 되어
 * 정상 사용자에게 경보가 쏟아진다. 새 기기 판정은 "브라우저 종류 × OS" 단위가 맞다 —
 * 그보다 세밀한 식별은 쿠키 기반 device id 의 몫이고 이 함수의 범위가 아니다.
 *
 * 파싱 불가(빈 UA 등)는 `"unknown"` 하나로 모은다. 모든 알 수 없는 기기가 같은 키가 되므로,
 * "UA 없는 로그인"이 매번 새 기기로 잡혀 경보를 만들지 않는다.
 */
export function deviceKey(userAgent: string | null | undefined): string {
  if (typeof userAgent !== "string" || userAgent.trim() === "") return "unknown";
  const ua = userAgent.slice(0, UA_SCAN_MAX);
  const browser = matchName(ua, BROWSERS) ?? "other";
  const platform = matchName(ua, PLATFORMS) ?? "other";
  return `${browser}/${platform}`.toLowerCase().replace(/\s+/g, "_");
}

/** 지역 비교를 위한 정규화. 호출부 표기 차이(대소문자·공백)로 같은 지역이 둘로 갈리지 않게 한다. */
function regionKey(region: string | null | undefined): string | null {
  if (typeof region !== "string") return null;
  const r = region.trim().toLowerCase();
  return r.length > 0 ? r : null;
}

export interface LoginContext {
  /** 이번 로그인의 UA. `deviceKey()` 로 정규화해 비교한다. */
  userAgent: string | null | undefined;
  /** 호출부가 IP 에서 해석한 지역(국가/도시 등). 수집 전이면 null — 지역 신호가 꺼진다. */
  region?: string | null;
}

export interface KnownLogins {
  /** 이 사용자의 이전 세션에서 모은 `deviceKey` 집합. */
  deviceKeys: readonly string[];
  /** 이전에 본 지역 집합. 지역을 수집하지 않으면 생략한다. */
  regions?: readonly string[];
}

export interface LoginRisk {
  /** 이력이 비어 있다 — 첫 로그인은 "새것"이 아니라 기준점이다. 이 경우 new* 는 전부 false. */
  firstLogin: boolean;
  newDevice: boolean;
  /** 지역 정보가 없으면(null) 항상 false — 모르는 것을 "새 지역"이라 하지 않는다. */
  newRegion: boolean;
  /** 알림을 보낼 근거가 있는가. 첫 로그인은 알리지 않는다. */
  shouldNotify: boolean;
}

/**
 * 이번 로그인이 새 기기/새 지역인지 판정한다 (P-012).
 *
 * 첫 로그인(이력 없음)은 기준점이므로 어떤 것도 "새것"이 아니다 — 가입 직후 자기 자신에게
 * "새 기기 로그인" 알림을 보내는 것은 노이즈다. 그 외에는 정규화한 키가 알려진 집합에
 * 없을 때만 새것으로 본다.
 */
export function assessLogin(current: LoginContext, known: KnownLogins, _now?: Date): LoginRisk {
  const curDevice = deviceKey(current.userAgent);
  const knownDevices = new Set((known.deviceKeys ?? []).map((k) => (typeof k === "string" ? k : "")).filter(Boolean));

  const curRegion = regionKey(current.region);
  const knownRegions = new Set(
    (known.regions ?? []).map((r) => regionKey(r)).filter((r): r is string => r !== null),
  );

  const firstLogin = knownDevices.size === 0;

  const newDevice = !firstLogin && !knownDevices.has(curDevice);
  // 지역 신호는 (a) 이번 지역을 알고, (b) 첫 로그인이 아니고, (c) 알려진 지역 중 없을 때만.
  const newRegion = !firstLogin && curRegion !== null && knownRegions.size > 0 && !knownRegions.has(curRegion);

  return { firstLogin, newDevice, newRegion, shouldNotify: !firstLogin && (newDevice || newRegion) };
}
