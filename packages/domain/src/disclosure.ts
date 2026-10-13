// N-022 공개 판정 — 5단계 권한 사다리 + masked discovery.
// 지침: docs/NETWORK_INTELLIGENCE.md §2. 보유·탐색·신원·연락처·소개는 서로 다른 권한이며, 하나를 통과했다고
// 다음이 열리지 않는다. 신원 공개가 금지되면 점수를 깎는 게 아니라 payload 를 masked 후보로 **변환**한다.
//
// 이 파일은 I/O 가 없는 순수 판정이다. 응답을 만드는 모든 경로는 반드시 applyDisclosure() 를 통과해야 한다 —
// 거기서 allowlist 로 새 객체를 만들기 때문에, 호출자가 실수로 PII 를 들고 있어도 응답에 새지 않는다.
//
// 직책을 카테고리로 뭉개는 `roleCategory()` 는 `taxonomy.ts` 에 있다 — 역할 목록을 두 군데 두면
// 한쪽만 바뀌어 masked 라벨과 분류 사전이 어긋난다.
import { roleCategory } from "./taxonomy";

export const DISCLOSURE_GATES = ["can_process", "can_discover", "can_request_intro", "can_reveal_identity", "can_reveal_contact"] as const;
export type DisclosureGate = (typeof DISCLOSURE_GATES)[number];

/** 응답 payload 형태. hidden = 후보 목록에도 넣지 않는다. */
export const DISCLOSURE_LEVELS = ["hidden", "masked", "intro_only", "full"] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

/** 당사자(또는 소유자)가 허용한 공유 범위. 패키지 consent_records.share_permission 과 같은 축이다. */
export const SHARE_PERMISSIONS = ["none", "path_only", "profile", "contact", "introduction"] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];

export interface DisclosureSubject {
  /** 뷰어 자신의 주소록에 있는 연락처(뷰어가 보유한 데이터) */
  ownedByViewer: boolean;
  /** 뷰어로부터의 촌수. 0=본인, 1=직접 아는 사람, 2·3=간접 */
  hops: number;
  sharePermission: SharePermission;
  /** 당사자가 탐색·매칭을 거부했거나 뷰어를 차단했다 */
  optOut: boolean;
  /** soft-delete 된 레코드 */
  deleted: boolean;
  /** 소개가 양측 동의까지 진행되어 연락처 공개 단계에 도달했다 */
  introApproved: boolean;
  /** 조직 멤버를 거쳐 도달한 경우의 공유 opt-in 상태. 조직 경유가 아니면 null */
  orgShareOptIn: boolean | null;
}

export interface DisclosureDecision {
  level: DisclosureLevel;
  gates: Record<DisclosureGate, boolean>;
  /** 왜 막혔는지 — 사용자에게 보여줘도, 로그에 남겨도 안전한 문구만 담는다(PII 없음) */
  reasons: string[];
  /** EdgeQuality 의 consent_gate 항(0 또는 1). 0 이면 그 엣지로 소개 action 을 만들지 않는다. */
  consentGate: 0 | 1;
}

const DENY = (reasons: string[]): DisclosureDecision => ({
  level: "hidden",
  gates: { can_process: false, can_discover: false, can_request_intro: false, can_reveal_identity: false, can_reveal_contact: false },
  reasons,
  consentGate: 0,
});

/**
 * 5단계를 순서대로 판정한다. 각 단계는 앞 단계를 전제하지만 자동으로 열리지 않는다.
 *
 * 내가 보유한 연락처(ownedByViewer)는 내가 받은 명함이므로 신원·연락처를 본다 — 그것이 교환의 의미다.
 * 하지만 그 사람을 **다른 사람에게** 노출할 권한은 share_permission 이 따로 정한다(2·3촌 탐색이 그 경우다).
 */
export function evaluateDisclosure(s: DisclosureSubject): DisclosureDecision {
  if (s.deleted) return DENY(["삭제된 레코드"]);
  // 당사자가 탐색을 거부한 것은 소유자에게도 적용된다 — 네트워크 기능에서 빼 달라는 명시적 의사다.
  if (s.optOut) return DENY(["당사자가 네트워크 탐색을 거부했습니다"]);

  // share_permission 과 org_share_opt_in 은 **다른 뷰어**에게 무엇을 보여줄지 정하는 값이다.
  // 소유자가 자기 연락처를 볼 때 이것으로 막으면, "조직에 공유하지 않겠다" 는 설정이
  // 내 주소록에서 그 사람을 지워 버린다. 그래서 소유자는 여기서 바로 통과시킨다.
  if (s.ownedByViewer) {
    return {
      level: "full",
      gates: { can_process: true, can_discover: true, can_request_intro: true, can_reveal_identity: true, can_reveal_contact: true },
      reasons: [],
      consentGate: 1,
    };
  }

  if (s.orgShareOptIn === false) return DENY(["조직 네트워크 공유에 동의하지 않은 멤버의 연락처입니다"]);

  const reasons: string[] = [];
  const canProcess = true;

  // 탐색: 남의 연락처는 최소 path_only 공유가 있어야 후보로 등장한다.
  const canDiscover = s.sharePermission !== "none";
  if (!canDiscover) return DENY(["공유 범위가 '없음'으로 설정된 연락처입니다"]);

  // 소개 요청: 1촌은 내가 직접 연락하면 되고, 간접(2·3촌)은 소개 요청의 대상이다.
  const canRequestIntro = s.sharePermission === "path_only" || s.sharePermission === "profile" || s.sharePermission === "contact" || s.sharePermission === "introduction";

  // 신원 공개: 내가 보유한 연락처거나, profile 이상 공유거나, 소개가 승인된 경우.
  const canRevealIdentity = s.introApproved || s.sharePermission === "profile" || s.sharePermission === "contact" || s.sharePermission === "introduction";
  if (!canRevealIdentity) reasons.push(s.hops >= 2 ? `${s.hops}촌 연락처는 소개 승인 전까지 신원을 공개하지 않습니다` : "신원 공개 권한이 없습니다");

  // 연락처 공개: 신원 공개 + (내 데이터이거나 contact 이상 공유 + 소개 승인).
  const canRevealContact = canRevealIdentity && s.introApproved && (s.sharePermission === "contact" || s.sharePermission === "introduction");
  if (canRevealIdentity && !canRevealContact) reasons.push(s.introApproved ? "연락처 공유 범위가 아닙니다" : "연락처는 소개 승인 이후에 공개됩니다");

  const level: DisclosureLevel = canRevealContact ? "full" : canRevealIdentity ? "intro_only" : canRequestIntro ? "masked" : "hidden";
  return {
    level,
    gates: { can_process: canProcess, can_discover: canDiscover, can_request_intro: canRequestIntro, can_reveal_identity: canRevealIdentity, can_reveal_contact: canRevealContact },
    reasons,
    consentGate: canRequestIntro ? 1 : 0,
  };
}

// ---------- masked 라벨 ----------

export interface MaskedFacets {
  hops: number;
  /** 산업 카테고리(개별 회사명이 아니다) */
  industry?: string | null;
  region?: string | null;
  /** 직책 카테고리 — "김철수 대표" 가 아니라 "대표/경영진" */
  roleCategory?: string | null;
  hasPath: boolean;
}

/**
 * masked 후보에 보여줄 유일한 라벨. 예: `2촌 · 의료기기 유통 · 서울 · 소개경로 있음`
 * 이름·회사명·이메일·전화는 들어가지 않는다.
 */
export function maskedLabel(f: MaskedFacets): string {
  const parts = [f.hops <= 1 ? "1촌" : `${f.hops}촌`];
  if (f.industry) parts.push(f.industry);
  if (f.roleCategory) parts.push(f.roleCategory);
  if (f.region) parts.push(f.region);
  parts.push(f.hasPath ? "소개경로 있음" : "소개경로 없음");
  return parts.join(" · ");
}

// ---------- payload 변환 ----------

/** 공개 판정 전의 내부 후보. PII 를 들고 있어도 되지만 그대로 응답에 쓰면 안 된다. */
export interface CandidateIdentity {
  id: string;
  type: "person" | "company" | "organization";
  displayName: string;
  companyName?: string | null;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  region?: string | null;
}

/** 응답에 실제로 나가는 형태. 필드 자체가 공개 수준에 따라 존재하거나 없다. */
export interface DisclosedCandidate {
  resultId: string;
  resultType: "person" | "company" | "organization";
  disclosure: Exclude<DisclosureLevel, "hidden">;
  /** masked 일 때 null */
  displayName: string | null;
  /** masked 일 때만 채워진다 */
  maskedLabel: string | null;
  companyName: string | null;
  jobTitle: string | null;
  /** full 일 때만 채워진다 */
  email: string | null;
  phone: string | null;
  industry: string | null;
  region: string | null;
  gates: Record<DisclosureGate, boolean>;
  withheldReasons: string[];
}

/**
 * 판정 결과를 payload 로 번역한다. **allowlist 방식**: 입력 객체를 spread 하지 않고 필드를 하나씩 옮긴다.
 * 그래서 호출자가 후보에 어떤 PII 를 더 달고 있든 응답에는 여기서 허용한 것만 나간다.
 * level 이 hidden 이면 null 을 돌려주고, 호출자는 그 후보를 목록에서 제외해야 한다.
 */
export function applyDisclosure(c: CandidateIdentity, d: DisclosureDecision, facets: Omit<MaskedFacets, "roleCategory"> & { roleCategory?: string | null }): DisclosedCandidate | null {
  if (d.level === "hidden") return null;
  const identity = d.gates.can_reveal_identity;
  const contact = d.gates.can_reveal_contact;
  return {
    resultId: c.id,
    resultType: c.type,
    disclosure: d.level,
    displayName: identity ? c.displayName : null,
    maskedLabel: identity ? null : maskedLabel({ ...facets, roleCategory: facets.roleCategory ?? roleCategory(c.jobTitle) }),
    // 회사명은 신원 식별로 이어지므로 신원 공개와 같은 게이트를 쓴다. 산업/지역은 masked 라벨에도 쓰이는 집계값이다.
    companyName: identity ? (c.companyName ?? null) : null,
    jobTitle: identity ? (c.jobTitle ?? null) : null,
    email: contact ? (c.email ?? null) : null,
    phone: contact ? (c.phone ?? null) : null,
    industry: c.industry ?? null,
    region: c.region ?? null,
    gates: d.gates,
    withheldReasons: d.reasons,
  };
}

/** 소개 요청이 가능한 다음 행동 목록. 공개 수준에 따라 다르다. */
export type NextAction = "request_intro" | "add_to_project" | "save" | "dismiss" | "correct_relationship" | "view_profile" | "contact_directly";

export function nextActions(d: DisclosureDecision): NextAction[] {
  const out: NextAction[] = [];
  if (d.gates.can_reveal_contact) out.push("contact_directly");
  if (d.gates.can_reveal_identity) out.push("view_profile");
  if (d.gates.can_request_intro && !d.gates.can_reveal_contact) out.push("request_intro");
  out.push("add_to_project", "save", "dismiss");
  if (d.gates.can_reveal_identity) out.push("correct_relationship");
  return out;
}
