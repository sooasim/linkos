/**
 * P-040: 블록 schema allowlist. (N-10 — 미니사이트에 사용자 JS 금지)
 *
 * 출처: proplus/docs/00_DEV_STRATEGY.md §2 N-10 (모듈명세 M03 "사용자 임의 JS 삽입 금지,
 *       HTML sanitizer·CSP·허용 블록 schema 적용")
 *       01_FEATURE_REGISTRY.yaml P-040 "허용된 블록 타입·속성만 저장된다. 임의 HTML 문자열 저장 경로가 없다"
 *       스키마: proplus/db/migrations/0001_proplus_core.sql `profile_blocks(kind, position, props jsonb, visible)`
 *
 * 설계 결정 세 개와 그 이유:
 *
 * 1) **허용 밖 키는 조용히 삭제한다(에러 아님).**
 *    블록 props 는 UI 가 만들어 보내는 구조물이다. 프런트가 임시 상태(`_dirty`, `draftId`)를
 *    같이 보내는 일은 정상이고, 그걸 400 으로 막으면 운영 중 저장이 통째로 실패한다.
 *    반대로 **저장되는 것은 화이트리스트뿐**이므로 조용히 버려도 안전 쪽으로만 틀린다.
 *
 * 2) **`html`/`script`/`style`/`on*` 로 시작하는 키는 거부한다(삭제 아님).**
 *    이 네 가지는 실수로 들어올 수 없다 — 들어왔다면 렌더러에 raw HTML/이벤트 핸들러를
 *    주입하려는 시도이거나, 누군가 N-10 을 우회하는 기능을 만들고 있다는 신호다.
 *    조용히 버리면 그 PR 이 통과해 버리므로 **눈에 보이게 실패**해야 한다.
 *
 * 3) **수치·배지·상품 본문을 블록에 저장하지 않는다.**
 *    블록은 "무엇을 어떤 순서로 보여줄지"만 담고(참조 ID·제목·안내문), 실제 배지·지표·상품은
 *    서버가 공개 뷰에서 읽어 넣는다. 지표를 블록 props 에 적을 수 있게 하면 기간·표본 없는
 *    수치가 공개되어 N-8 이 깨진다 (보안정책 §4.8).
 */

import { sanitizeText, stripDangerousUrl } from "./sanitize";

export const BLOCK_KINDS = [
  "intro",
  "badges",
  "specialties",
  "offers",
  "faq",
  "contact",
  "links",
  "metrics",
  "career",
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

export interface Block {
  kind: BlockKind;
  position: number;
  props: Record<string, unknown>;
  visible: boolean;
}

export type BlockResult = { ok: true; block: Block } | { ok: false; code: string; message: string };
export type BlocksResult = { ok: true; blocks: Block[] } | { ok: false; code: string; message: string };

/** 한 프로필의 블록 상한. 공개 프로필은 인증 없이 SSR 로 뜨므로 렌더 비용에 상한이 필요하다. */
export const MAX_BLOCKS = 24;

/** `profile_blocks.position` 은 integer 다. 음수는 거부하고 상한을 둬 정렬 키를 예측 가능하게 유지한다. */
const MAX_POSITION = 999;

/** 블록 제목 길이. 공개 화면의 타이포 스케일을 깨지 않는 선. */
const HEADING_MAX = 80;

type PropSpec =
  | { readonly t: "text"; readonly max: number }
  | { readonly t: "bool" }
  | { readonly t: "int"; readonly min: number; readonly max: number }
  | { readonly t: "url" }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "textList"; readonly max: number; readonly itemMax: number }
  | {
      readonly t: "objectList";
      readonly max: number;
      readonly fields: Readonly<Record<string, PropSpec>>;
      readonly required: readonly string[];
    };

const HEADING: PropSpec = { t: "text", max: HEADING_MAX };
const NOTE: PropSpec = { t: "text", max: 300 };
const LAYOUT: PropSpec = { t: "enum", values: ["list", "grid"] };

/** 참조 ID(uuid)를 담는 리스트. 존재 여부는 모듈이 SQL 로 확인한다 — 여기서는 모양만 본다. */
const idList = (max: number): PropSpec => ({ t: "textList", max, itemMax: 64 });

/**
 * kind 별 허용 props. **이 표에 없는 키는 저장되지 않는다.**
 * 새 속성을 추가하려면 이 표를 고쳐야 하고, 그러면 리뷰가 걸린다 (ADR-002 와 같은 취지).
 */
const BLOCK_PROPS: Readonly<Record<BlockKind, Readonly<Record<string, PropSpec>>>> = {
  // 자기소개. 이미지는 URL 만 담고 업로드·리사이즈는 P-047 이 처리한다.
  intro: {
    heading: HEADING,
    body: { t: "text", max: 1200 },
    imageUrl: { t: "url" },
  },
  // 어떤 배지를 어떤 순서로 보일지만 고른다. 배지 내용(라벨·검증강도·발급기관)은
  // `badge.ts` 의 `toPublicBadge()` 결과만 쓴다 — 사용자가 라벨을 쓸 수 있으면 N-2·N-14 가 깨진다.
  badges: {
    heading: HEADING,
    badgeTypes: { t: "textList", max: 12, itemMax: 40 },
    layout: LAYOUT,
  },
  specialties: {
    heading: HEADING,
    items: { t: "textList", max: 20, itemMax: 60 },
  },
  offers: {
    heading: HEADING,
    offerIds: idList(12),
    layout: LAYOUT,
  },
  // P-034: 질문·답변 쌍, 텍스트만.
  faq: {
    heading: HEADING,
    items: {
      t: "objectList",
      max: 20,
      fields: { q: { t: "text", max: 200 }, a: { t: "text", max: 1000 } },
      required: ["q", "a"],
    },
  },
  // P-036 상담 CTA. showEmail/showPhone 은 "자리를 둘지"라는 표시 의도일 뿐이고,
  // 실제 공개 여부는 `publicDto.publicContact()` 가 공개 설정을 보고 정한다 (P-029).
  contact: {
    heading: HEADING,
    note: NOTE,
    ctaLabel: { t: "text", max: 40 },
    showEmail: { t: "bool" },
    showPhone: { t: "bool" },
  },
  // P-033: http(s) 만. rel=nofollow noopener 는 렌더러가 붙인다.
  links: {
    heading: HEADING,
    items: {
      t: "objectList",
      max: 20,
      fields: { label: { t: "text", max: 60 }, url: { t: "url" } },
      required: ["label", "url"],
    },
  },
  // N-8: 지표 **코드**만 고른다. 수치·기간·표본은 `public_metric_view` 가 함께 내려주며
  // 하나라도 없으면 숨겨진다. 그래서 여기에 value/unit 같은 키가 **없는 것이 규칙 자체다.**
  metrics: {
    heading: HEADING,
    metricCodes: { t: "textList", max: 8, itemMax: 48 },
    note: NOTE,
  },
  // N-1: 경력 항목의 검증 여부는 `profile_facts.verification_id` 가 결정한다.
  // 블록은 어떤 항목을 보일지만 고르고, "검증됨" 표기를 직접 쓸 수 없다.
  career: {
    heading: HEADING,
    note: NOTE,
    factIds: idList(30),
  },
};

function isBlockKind(value: string): value is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(value);
}

/** N-10: 렌더러에 raw HTML·이벤트 핸들러를 주입하려는 키 이름. */
function isForbiddenKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("on") || k.startsWith("html") || k.startsWith("script") || k.startsWith("style");
}

/**
 * props 트리 전체를 재귀로 훑어 금지 키가 있는지 본다.
 * 화이트리스트가 이미 값을 버리지만, **거부해야 하는 신호**는 버리기 전에 잡아야 한다.
 * (publicDto.findPrivateKey() 와 같은 모양으로 맞춘다 — 같은 습관을 읽기 쉽게.)
 */
export function findForbiddenPropKey(value: unknown, path = "props"): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenPropKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) return `${path}.${k}`;
    const hit = findForbiddenPropKey(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

/** 값을 spec 모양으로 접는다. `undefined` 를 돌려주면 "이 값은 버린다"는 뜻이다. */
function coerce(spec: PropSpec, raw: unknown): unknown {
  switch (spec.t) {
    case "text": {
      if (typeof raw !== "string") return undefined;
      const s = sanitizeText(raw, spec.max);
      return s.length > 0 ? s : undefined;
    }
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;
    case "int": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
      return raw >= spec.min && raw <= spec.max ? raw : undefined;
    }
    case "url": {
      if (typeof raw !== "string") return undefined;
      // 통과하지 못한 URL 은 "빈 링크"로 남기지 않고 아예 버린다 (P-033).
      return stripDangerousUrl(raw) ?? undefined;
    }
    case "enum": {
      if (typeof raw !== "string") return undefined;
      return spec.values.includes(raw) ? raw : undefined;
    }
    case "textList": {
      if (!Array.isArray(raw)) return undefined;
      const out: string[] = [];
      for (const v of raw) {
        if (out.length >= spec.max) break;
        if (typeof v !== "string") continue;
        const s = sanitizeText(v, spec.itemMax);
        if (s.length > 0) out.push(s);
      }
      return out.length > 0 ? out : undefined;
    }
    case "objectList": {
      if (!Array.isArray(raw)) return undefined;
      const out: Record<string, unknown>[] = [];
      for (const v of raw) {
        if (out.length >= spec.max) break;
        if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
        const src = v as Record<string, unknown>;
        const item: Record<string, unknown> = {};
        for (const [key, fieldSpec] of Object.entries(spec.fields)) {
          const got = coerce(fieldSpec, src[key]);
          if (got !== undefined) item[key] = got;
        }
        // 필수 필드가 비면 **그 항목만** 떨어뜨린다. 링크의 url 이 stripDangerousUrl 을
        // 통과하지 못한 경우가 여기 해당한다 — 나머지 링크는 살린다.
        if (spec.required.some((k) => item[k] === undefined)) continue;
        out.push(item);
      }
      return out.length > 0 ? out : undefined;
    }
  }
}

/**
 * 블록 하나를 검증·정규화한다. 성공 시 돌려받은 `block` 을 그대로 저장해야 한다
 * (입력 원문을 저장하면 sanitize 가 적용되지 않은 값이 들어간다).
 */
export function validateBlock(input: unknown): BlockResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "block_not_object", message: "블록은 객체여야 합니다." };
  }
  const src = input as Record<string, unknown>;

  const kind = src.kind;
  if (typeof kind !== "string" || !isBlockKind(kind)) {
    return { ok: false, code: "unknown_block_kind", message: "허용되지 않은 블록 종류입니다." };
  }

  const position = src.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > MAX_POSITION) {
    return { ok: false, code: "invalid_position", message: `블록 순서는 0 이상 ${MAX_POSITION} 이하의 정수여야 합니다.` };
  }

  const rawProps = src.props === undefined ? {} : src.props;
  if (rawProps === null || typeof rawProps !== "object" || Array.isArray(rawProps)) {
    return { ok: false, code: "props_not_object", message: "블록 속성은 객체여야 합니다." };
  }

  // 거부가 먼저다 — 조용히 버리면 N-10 우회 시도가 테스트·리뷰에 걸리지 않는다.
  const forbidden = findForbiddenPropKey(rawProps);
  if (forbidden) {
    return {
      ok: false,
      code: "forbidden_prop_key",
      message: `블록 속성에 사용할 수 없는 키입니다: ${forbidden}`,
    };
  }

  const spec = BLOCK_PROPS[kind];
  const source = rawProps as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const [key, fieldSpec] of Object.entries(spec)) {
    const got = coerce(fieldSpec, source[key]);
    if (got !== undefined) props[key] = got;
  }

  // 명시하지 않으면 보이는 쪽이 기본이다. 저장한 블록이 이유 없이 사라지는 것보다
  // 보이는 편이 사용자의 기대에 맞다.
  const visible = typeof src.visible === "boolean" ? src.visible : true;

  return { ok: true, block: { kind, position, props, visible } };
}

/**
 * 블록 목록 전체. `profile_blocks` 의 `UNIQUE (profile_id, position)` 를 쓰기 전에 거른다 —
 * DB 제약에 맡기면 23505 가 올라와 어느 블록이 문제인지 사용자에게 설명할 수 없다.
 */
export function validateBlocks(input: unknown): BlocksResult {
  if (!Array.isArray(input)) {
    return { ok: false, code: "blocks_not_array", message: "블록 목록은 배열이어야 합니다." };
  }
  if (input.length > MAX_BLOCKS) {
    return { ok: false, code: "too_many_blocks", message: `블록은 최대 ${MAX_BLOCKS}개까지 사용할 수 있습니다.` };
  }

  const blocks: Block[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    const result = validateBlock(input[i]);
    if (!result.ok) {
      return { ok: false, code: result.code, message: `${i + 1}번째 블록: ${result.message}` };
    }
    if (seen.has(result.block.position)) {
      return { ok: false, code: "duplicate_position", message: `블록 순서가 중복됩니다: ${result.block.position}` };
    }
    seen.add(result.block.position);
    blocks.push(result.block);
  }

  return { ok: true, blocks };
}
