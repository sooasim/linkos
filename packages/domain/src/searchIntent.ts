// N-015 자연어 Intent Parser — 자연어 질의를 SearchIntent 로 구조화한다.
// 지침: docs/NETWORK_INTELLIGENCE.md §7 — LLM 은 이 단계를 **대체**할 수 있지만 최종권한은 없다.
// 이 파서는 규칙 기반이라 LLM 없이도 동작하고, LLM 출력이 schema validation 에 실패했을 때의
// deterministic fallback 이기도 하다(hallucination guard).
//
// 예: "베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘"
//  → { geographies:["베트남"], industries:["의료기기","유통·도소매"], targetTypes:["company"], networkHopsMax:3 }

import { type TaxonomyAlias, findWithAliases } from "./taxonomy";

export const TARGET_TYPES = ["person", "company", "organization"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export interface SearchIntent {
  raw: string;
  /** 사용자가 달성하려는 것 — 설명 생성과 저장된 검색 이름에 쓴다 */
  goal: string | null;
  targetTypes: TargetType[];
  industries: string[];
  geographies: string[];
  roles: string[];
  /** 찾는 역량(상대가 제공해야 하는 것). 규칙 추출이라 **초안**이며 사용자가 chip 으로 수정한다 */
  capabilities: string[];
  /** 반드시 만족해야 하는 조건. hard gate 로 쓰인다 — 점수로 상쇄되지 않는다 */
  mustHave: string[];
  niceToHave: string[];
  /** 1..3 */
  networkHopsMax: number;
  /** 최근 N일 이내 접촉/활동으로 한정. null = 제한 없음 */
  recencyDays: number | null;
  privacyMode: "normal" | "masked_until_intro";
  projectId: string | null;
  provenance: "rule_parsed" | "llm_parsed" | "user_edited";
  /** 파서가 해석하지 못하고 남은 텍스트. 화면에 "해석하지 못한 조건"으로 보여준다 */
  unparsed: string;
}

const HOP_PATTERNS: [RegExp, (m: RegExpMatchArray) => number][] = [
  [/([1-9])\s*촌/, (m) => Number(m[1])],
  [/within\s+([1-9])\s*hops?/i, (m) => Number(m[1])],
  [/([1-9])\s*hops?\s*(이내|안|내)/i, (m) => Number(m[1])],
  [/(직접\s*아는|내가\s*아는|1촌|바로\s*아는|직접\s*연결)/, () => 1],
  [/(먼\s*인맥|넓게|3촌까지|전체\s*네트워크)/, () => 3],
];

const RECENCY_UNIT: Record<string, number> = { 일: 1, day: 1, days: 1, 주: 7, week: 7, weeks: 7, 개월: 30, 달: 30, month: 30, months: 30, 년: 365, year: 365, years: 365 };

const MUST_CUE = /(반드시|필수|꼭|있어야|must\s+have|required|필요조건)/i;
const NICE_CUE = /(가능하면|있으면\s*좋|우대|선호|preferred|nice\s+to\s+have)/i;

const COMPANY_CUE = /(회사|기업|업체|법인|제조사|공급사|벤더|vendor|company|corp|거래처|파트너사|대리점|총판|유통사)/i;
const ORG_CUE = /(협회|모임|챕터|동문|단체|조합|학회|커뮤니티|association|chapter|club|네트워크\s*모임)/i;
const PERSON_CUE = /(사람|분|담당자|인물|person|누구|누가|실무자|의사결정자|키맨)/i;

/** 역량 구절에서 떼어낼 조사·어미. 의미 단어만 남긴다. */
const TAIL = /(을|를|이|가|은|는|의|에|와|과|에서|으로|로|도|만|까지|부터|할|하는|하실|가능한|가능|관련|쪽|분야|업체|회사|사람|찾아줘|찾아|찾고\s*있어|알려줘|추천해줘|소개해줘|필요해|필요합니다)$/;
const FILLER = /^(내|나의|우리|저희|제|그|이|저|좀|한번|지금|현재|관련|해당|있는|없는|어떤|무슨)$/;

function parseHops(q: string): number {
  for (const [re, pick] of HOP_PATTERNS) {
    const m = q.match(re);
    if (m) return Math.max(1, Math.min(3, pick(m)));
  }
  return 3;
}

function parseRecency(q: string): number | null {
  if (/올해|this\s+year/i.test(q)) return 365;
  const m = q.match(/(?:최근|지난|within|last)\s*(\d{1,3})\s*(일|주|개월|달|년|days?|weeks?|months?|years?)/i);
  if (!m) return null;
  const unit = RECENCY_UNIT[m[2]!.toLowerCase()];
  return unit ? Number(m[1]) * unit : null;
}

function parseTargetTypes(q: string): TargetType[] {
  const out: TargetType[] = [];
  if (COMPANY_CUE.test(q)) out.push("company");
  if (ORG_CUE.test(q)) out.push("organization");
  if (PERSON_CUE.test(q)) out.push("person");
  // 아무 단서도 없으면 사람과 회사를 모두 본다 — 조직(협회)은 명시적으로 요청할 때만 섞는다
  return out.length ? out : ["person", "company"];
}

/** `반드시`/`가능하면` 같은 단서가 붙은 절을 뽑아낸다. 절 단위로 자르고 단서어는 제거한다. */
function parseConstraints(q: string): { mustHave: string[]; niceToHave: string[] } {
  const mustHave: string[] = [];
  const niceToHave: string[] = [];
  for (const seg of q.split(/[,.;·\n]|그리고|및(?=\s)/).map((s) => s.trim())) {
    if (!seg || seg.length < 3) continue;
    const clean = seg.replace(MUST_CUE, "").replace(NICE_CUE, "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2) continue;
    if (MUST_CUE.test(seg)) mustHave.push(clean);
    else if (NICE_CUE.test(seg)) niceToHave.push(clean);
  }
  return { mustHave, niceToHave };
}

/**
 * 분류값으로 설명되지 않은 의미 구절을 역량 후보로 남긴다. 새 단어를 만들지 않고 입력에서 잘라내기만 한다.
 * 결과는 **초안**이며 화면에서 사용자가 chip 으로 지우거나 고칠 수 있어야 한다.
 */
function parseCapabilities(q: string, matched: string[]): { capabilities: string[]; unparsed: string } {
  let rest = q;
  // 매칭된 분류 표현과 구조 단서를 지운다
  for (const m of matched) rest = rest.replace(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  rest = rest
    .replace(/[1-9]\s*촌\s*(이내|안에서|안|내)?/g, " ")
    .replace(/within\s+[1-9]\s*hops?/gi, " ")
    .replace(/(?:최근|지난|within|last)\s*\d{1,3}\s*(?:일|주|개월|달|년|days?|weeks?|months?|years?)/gi, " ")
    .replace(COMPANY_CUE, " ")
    .replace(ORG_CUE, " ")
    .replace(PERSON_CUE, " ")
    .replace(MUST_CUE, " ")
    .replace(NICE_CUE, " ");

  const capabilities: string[] = [];
  const leftovers: string[] = [];
  for (const seg of rest.split(/[,.;·\n\s]+/)) {
    const w = seg.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(TAIL, "");
    if (!w || w.length < 2 || FILLER.test(w)) {
      if (w && w.length >= 2) leftovers.push(w);
      continue;
    }
    if (!capabilities.includes(w)) capabilities.push(w);
  }
  return { capabilities: capabilities.slice(0, 6), unparsed: leftovers.join(" ").trim() };
}

export interface ParseOptions {
  projectId?: string | null;
  /** 호출자가 이미 아는 조건(프로젝트에서 상속 등) */
  defaults?: Partial<Pick<SearchIntent, "industries" | "geographies" | "roles" | "networkHopsMax" | "privacyMode">>;
  /** N-107 사용자·조직 별칭. 사전 밖 표현을 canonical 값으로 흡수한다 */
  aliases?: TaxonomyAlias[];
}

/** 규칙 기반 파싱. 같은 질의면 항상 같은 결과를 돌려준다(결정적). */
export function parseSearchIntent(query: string, opts: ParseOptions = {}): SearchIntent {
  const raw = query.trim();
  const al = opts.aliases ?? [];
  const industries = dedupe([...(opts.defaults?.industries ?? []), ...findWithAliases(raw, "industry", al)]);
  const geographies = dedupe([...(opts.defaults?.geographies ?? []), ...findWithAliases(raw, "region", al)]);
  const roles = dedupe([...(opts.defaults?.roles ?? []), ...findWithAliases(raw, "role", al)]);
  const { mustHave, niceToHave } = parseConstraints(raw);
  // 별칭으로 잡힌 표현도 지워야 한다 — canonical 이름만 지우면 별칭 단어("메디텍")가 역량 후보로 남는다
  const matchedAliases = al.filter((a) => raw.toLowerCase().includes(a.alias.toLowerCase())).map((a) => a.alias);
  const { capabilities, unparsed } = parseCapabilities(raw, [...industries, ...geographies, ...roles, ...matchedAliases]);
  return {
    raw,
    goal: raw.length > 2 ? raw.slice(0, 200) : null,
    targetTypes: parseTargetTypes(raw),
    industries,
    geographies,
    roles,
    capabilities,
    mustHave,
    niceToHave,
    networkHopsMax: opts.defaults?.networkHopsMax ?? parseHops(raw),
    recencyDays: parseRecency(raw),
    // 간접 연락처를 기본 masked 로 둔다(§2). 호출자가 normal 로 내리는 것은 소유한 데이터에 한정해야 한다.
    privacyMode: opts.defaults?.privacyMode ?? "masked_until_intro",
    projectId: opts.projectId ?? null,
    provenance: "rule_parsed",
    unparsed,
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

/** chip 수정 결과를 반영한다. 사용자가 고친 intent 는 provenance 가 바뀌어 재파싱되지 않는다. */
export function applyIntentEdits(intent: SearchIntent, edits: Partial<SearchIntent>): SearchIntent {
  return { ...intent, ...edits, provenance: "user_edited" };
}

/** LLM 이 돌려준 객체가 SearchIntent 로 쓸 수 있는지 검증한다. 실패하면 null → 규칙 파서로 폴백한다. */
export function validateParsedIntent(value: unknown, raw: string): SearchIntent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const strArr = (x: unknown): string[] | null => (Array.isArray(x) && x.every((i) => typeof i === "string") ? (x as string[]).slice(0, 20) : null);
  const industries = strArr(v.industries ?? []);
  const geographies = strArr(v.geographies ?? []);
  const roles = strArr(v.roles ?? []);
  const capabilities = strArr(v.capabilities ?? []);
  const mustHave = strArr(v.mustHave ?? []);
  const niceToHave = strArr(v.niceToHave ?? []);
  const types = strArr(v.targetTypes ?? []);
  if (!industries || !geographies || !roles || !capabilities || !mustHave || !niceToHave || !types) return null;
  const targetTypes = types.filter((t): t is TargetType => (TARGET_TYPES as readonly string[]).includes(t));
  if (!targetTypes.length) return null;
  const hops = typeof v.networkHopsMax === "number" && v.networkHopsMax >= 1 && v.networkHopsMax <= 3 ? Math.trunc(v.networkHopsMax) : 3;
  return {
    raw,
    goal: typeof v.goal === "string" ? v.goal.slice(0, 200) : raw.slice(0, 200),
    targetTypes,
    industries,
    geographies,
    roles,
    capabilities,
    mustHave,
    niceToHave,
    networkHopsMax: hops,
    recencyDays: typeof v.recencyDays === "number" && v.recencyDays > 0 ? Math.trunc(v.recencyDays) : null,
    // LLM 이 privacy 를 완화하는 것은 허용하지 않는다(§7 금지사항)
    privacyMode: "masked_until_intro",
    projectId: null,
    provenance: "llm_parsed",
    unparsed: "",
  };
}
