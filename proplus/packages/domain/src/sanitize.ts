/**
 * P-041: 텍스트 sanitizer / P-033: 외부 링크 스킴 제한. (N-10)
 *
 * 출처: proplus/docs/00_DEV_STRATEGY.md §2 N-10 "미니사이트에 사용자 JS 금지"
 *       (모듈명세 M03 — HTML sanitizer, CSP, 허용 블록 schema)
 *       01_FEATURE_REGISTRY.yaml P-041 "저장 시점과 렌더 시점 모두 적용"
 *
 * 왜 외부 라이브러리를 쓰지 않는가:
 *   DOMPurify 계열은 **DOM 이 전제**다. 이 패키지는 I/O·DOM 없는 순수 도메인이고
 *   같은 함수가 저장 경로(Node)와 렌더 경로에서 같은 결과를 내야 한다.
 *   그리고 우리가 보존해야 하는 HTML 은 **하나도 없다** — PROPLUS 는 블록 schema 로만
 *   구조를 표현하므로(N-10), sanitizer 의 일은 "안전한 태그를 남기는 것"이 아니라
 *   "텍스트만 남기는 것"이다. 그 범위라면 허용목록 파서보다 아래 파이프라인이 더 작고 검증하기 쉽다.
 *
 * 왜 꺾쇠(`<`, `>`)를 마지막에 전부 지우는가:
 *   반환값이 어떤 렌더러를 만나도 태그가 될 수 없게 만드는 것이 목적이다.
 *   React 가 자동 이스케이프하더라도, 나중에 누군가 PDF·메일 템플릿처럼 raw 문자열을
 *   끼워 넣는 경로를 추가하면 그 경로만 뚫린다. 수식 표현("a < b")이 깨지는 비용을 감수한다.
 */

/** 기본 길이 상한. 블록 schema 는 필드별로 더 짧은 값을 넘긴다. */
const DEFAULT_MAX_LEN = 2000;

/**
 * 엔티티 디코딩 반복 상한 — `&amp;lt;script&amp;gt;` 같은 다중 인코딩을 접되 무한 루프를 막는다.
 *
 * 상한이 **고정점이 아니면 멱등성이 깨진다.** 이 함수는 저장 전과 렌더 전에 각각 한 번씩
 * 적용되므로(모듈 주석의 불변식), 두 결과가 다르면 DB 에 있는 값과 화면에 나오는 값이 달라진다.
 * 그래서 상한을 넉넉히 두고 **안정될 때까지 돌린 뒤**, 그래도 안 끝나면 남은 `&` 를 없애
 * 더 이상 디코딩될 수 없는 상태로 만든다 (아래 sanitizeText 참조).
 */
const DECODE_PASSES = 12;

/** 디코딩할 named 엔티티. 태그·스킴을 복원시킬 수 있는 것만 다룬다(모르는 엔티티는 원문 유지). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sol: "/",
  colon: ":",
  tab: "\t",
  newline: "\n",
};

const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

/** 내용까지 버려야 하는 요소 — 태그만 떼면 본문이 평문으로 남아 의미가 바뀐다. */
const CONTENT_BEARING_RE = /<\s*(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;

/** 제어문자. \t(09) \n(0A) \r(0D) 는 공백 정규화 단계에서 다루므로 여기서 지우지 않는다. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** URL 안의 공백·제어문자. 스킴을 숨기는 데만 쓰인다("java<TAB>script:"). 정상 URL 은 %20 으로 들어온다. */
const URL_NOISE_RE = /[\s\u0000-\u001F\u007F]/g;

/**
 * 지워야 하는 "보이지 않는" 코드포인트 구간 (zero-width · bidi 제어 · BOM).
 *
 * 왜 정규식 리터럴에 직접 넣지 않는가: 소스에 보이지 않는 문자가 박히면 리뷰에서
 * 무엇을 지우는지 읽을 수 없고, 에디터·머지 도구가 조용히 바꿔도 알아챌 수 없다.
 * 그래서 코드포인트로 적고 런타임에 문자 클래스를 만든다.
 *
 * 왜 지우는가: 이름·헤드라인에 섞으면 눈에 같은 글자로 보이는 다른 문자열이 되어
 * 다른 전문가 사칭과 중복 검사 우회에 쓰인다 (보안정책 §4.7 오해를 부르는 표현 금지와 같은 취지).
 * ZWJ(0x200D)는 이모지 결합에 필요하므로 **구간에서 제외해 남긴다.**
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200c], // ZWSP, ZWNJ
  [0x200e, 0x200f], // LRM, RLM
  [0x202a, 0x202e], // bidi embedding / override
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolate
  [0xfeff, 0xfeff], // BOM
];

const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "gu",
);

function decodeEntitiesOnce(input: string): string {
  return input.replace(ENTITY_RE, (match: string, group: string): string => {
    if (group.startsWith("#")) {
      const isHex = group[1] === "x" || group[1] === "X";
      const digits = isHex ? group.slice(2) : group.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    const named = NAMED_ENTITIES[group.toLowerCase()];
    return named ?? match;
  });
}

/**
 * 저장 전·렌더 전 둘 다 통과시키는 평문 정규화 (P-041).
 *
 * 두 번 적용해도 결과가 같아야 한다(idempotent) — 저장된 값이 다시 저장돼도 뭉개지지 않아야
 * 하므로 이 성질을 단위테스트로 고정한다.
 */
export function sanitizeText(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (typeof input !== "string") return "";

  let s = input;

  // 1) 엔티티를 먼저 푼다. 풀지 않으면 `&lt;script&gt;` 가 태그 제거를 통과한 뒤
  //    렌더 단계에서 디코딩돼 살아난다.
  let settled = false;
  for (let i = 0; i < DECODE_PASSES; i++) {
    const next = decodeEntitiesOnce(s);
    if (next === s) {
      settled = true;
      break;
    }
    s = next;
  }
  // 상한 안에 안정되지 않은 입력은 사람이 쓴 글이 아니라 중첩 인코딩 공격이다.
  // 남은 `&` 를 지워 **고정점으로 만든다** — 그래야 저장값과 렌더값이 같아지고(멱등),
  // 이후 어떤 패스에서도 꺾쇠나 스킴이 복원되지 않는다.
  if (!settled) s = s.replace(/&/g, "");

  // 2) 제어문자·보이지 않는 문자·짝 없는 서로게이트 제거.
  s = s.replace(CONTROL_RE, "").replace(INVISIBLE_RE, "").replace(/\p{Cs}/gu, "");

  // 3) 마크업 제거: 내용까지 버릴 요소 -> 주석 -> 남은 태그 -> 남은 꺾쇠.
  s = s.replace(CONTENT_BEARING_RE, " ");
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/[<>]/g, "");

  // 4) 공백 정규화. 단락 구분(빈 줄 하나)은 남기고 그 이상은 접는다 —
  //    자기소개(bio)·FAQ 답변의 가독성을 지키려는 것이다.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[^\S\n]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  // 5) 길이 제한. 코드 포인트 단위로 잘라 서로게이트 쌍이 쪼개지지 않게 한다.
  const limit = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : DEFAULT_MAX_LEN;
  const points = Array.from(s);
  if (points.length > limit) s = points.slice(0, limit).join("").trimEnd();

  return s;
}

/**
 * P-033: 외부 링크는 http/https 만 통과한다. 그 외는 `null`.
 *
 * 왜 문자열 검사만으로 끝내지 않는가:
 *   `javascript:`, `data:text/html;base64,...`, `vbscript:`, `file:` 는 물론이고
 *   대소문자 변형·공백 삽입처럼 변형이 끝이 없다. 그래서 (a) 제어문자·공백을 먼저 지우고
 *   (b) 스킴 판정을 `URL` 파서에 넘긴다. `URL` 은 네트워크를 타지 않는 순수 파서이므로
 *   이 패키지의 I/O 금지 규칙을 어기지 않는다.
 *
 * 반환값은 **정규화된 URL** 이다. 호출부는 입력 원문이 아니라 이 값을 저장·렌더해야 한다.
 */
export function stripDangerousUrl(url: string): string | null {
  if (typeof url !== "string") return null;

  const cleaned = url.replace(URL_NOISE_RE, "");
  if (cleaned.length === 0) return null;
  // 과도하게 긴 URL 은 data: 우회·로그 오염 수단으로만 쓰인다.
  if (cleaned.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    // 상대경로는 외부 링크가 아니다 — 블록 props 에 들어올 이유가 없으므로 거부한다.
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  // `https://proplus.linkos.com@evil.example` 류 사칭을 막는다 — 자격증명을 담은 URL 은 거부.
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;

  return parsed.toString();
}

/** `stripDangerousUrl` 과 같은 판정의 boolean 형태. 렌더 시점 가드에서 쓴다. */
export function isSafeExternalUrl(url: string): boolean {
  return stripDangerousUrl(url) !== null;
}
