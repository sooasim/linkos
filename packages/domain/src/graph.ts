// F-133 관계 그래프(레이아웃) · F-134 Who Knows Whom · F-097/F-152 AI 소개 후보 · F-099 Opportunity Detection
// 결과는 모두 provenance "ai_inferred" + 설명 가능한 근거(reasons)를 가진다.
import { textSimilarity } from "./match";

// ---------- F-134 ----------
export interface KnowsPath {
  memberId: string;
  memberName: string;
  /** null when the contact is a member's personal (unshared) contact: only the aggregate is revealed */
  contactId: string | null;
  contactName: string | null;
  jobTitle: string | null;
  strength: number;
  shared: boolean;
}

export interface WhoKnowsResult {
  memberId: string;
  memberName: string;
  score: number;
  bestStrength: number;
  count: number;
  contacts: { contactId: string | null; name: string | null; jobTitle: string | null; strength: number; shared: boolean }[];
  reasons: string[];
}

export function rankWhoKnows(paths: KnowsPath[]): WhoKnowsResult[] {
  const by = new Map<string, WhoKnowsResult>();
  for (const p of paths) {
    const r = by.get(p.memberId) ?? { memberId: p.memberId, memberName: p.memberName, score: 0, bestStrength: 0, count: 0, contacts: [], reasons: [] };
    r.count++;
    r.bestStrength = Math.max(r.bestStrength, p.strength);
    r.contacts.push({ contactId: p.shared ? p.contactId : null, name: p.shared ? p.contactName : null, jobTitle: p.shared ? p.jobTitle : null, strength: Math.round(p.strength * 100) / 100, shared: p.shared });
    by.set(p.memberId, r);
  }
  const out = [...by.values()];
  for (const r of out) {
    r.contacts.sort((a, b) => b.strength - a.strength);
    r.score = Math.round((r.bestStrength * 0.7 + Math.min(1, r.count / 5) * 0.3) * 100) / 100;
    r.reasons = [`가장 강한 관계 강도 ${Math.round(r.bestStrength * 100) / 100}`, `아는 사람 ${r.count}명`];
    const hidden = r.contacts.filter((c) => !c.shared).length;
    if (hidden) r.reasons.push(`개인 연락처 ${hidden}명은 이름 비공개(본인에게 소개 요청)`);
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
}

// ---------- F-097 / F-152 ----------
export interface IntroPerson {
  id: string;
  name: string;
  company: string | null;
  offers: string[];
  needs: string[];
  industries: string[];
  /** strength between the introducer (or the member who knows them) and this person */
  strength: number;
  /** who knows this person (graph path hop), e.g. "me" or an org member name */
  via: string;
}

export interface IntroCandidate {
  partyA: { id: string; name: string; company: string | null; via: string };
  partyB: { id: string; name: string; company: string | null; via: string };
  score: number;
  reasons: string[];
  path: string[];
  provenance: "ai_inferred";
}

export function introCandidates(people: IntroPerson[], limit = 20): IntroCandidate[] {
  const list = people.slice(0, 300);
  const out: IntroCandidate[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.company && b.company && a.company === b.company) continue; // same company: not an introduction
      const reasons: string[] = [];
      let sem = 0;
      for (const [x, y] of [[a, b], [b, a]] as const) {
        for (const need of x.needs) {
          for (const offer of y.offers) {
            const s = textSimilarity(need, offer);
            if (s > 0.2) reasons.push(`${x.name}의 Need “${need}” ↔ ${y.name}의 Offer “${offer}”`);
            sem = Math.max(sem, s);
          }
        }
      }
      if (sem <= 0.2) continue;
      const ind = a.industries.filter((x) => b.industries.map((y) => y.toLowerCase()).includes(x.toLowerCase()));
      if (ind.length) reasons.push(`공통 산업: ${ind.join(", ")}`);
      const trust = (a.strength + b.strength) / 2;
      reasons.push(`소개자 관계 강도: ${a.name} ${Math.round(a.strength * 100) / 100} · ${b.name} ${Math.round(b.strength * 100) / 100}`);
      const score = Math.round(Math.min(1, Math.min(1, sem * 1.4) * 0.6 + trust * 0.25 + (ind.length ? 0.15 : 0)) * 100) / 100;
      out.push({
        partyA: { id: a.id, name: a.name, company: a.company, via: a.via },
        partyB: { id: b.id, name: b.name, company: b.company, via: b.via },
        score,
        reasons: reasons.slice(0, 4),
        path: [a.name, a.via, ...(a.via === b.via ? [] : [b.via]), b.name],
        provenance: "ai_inferred",
      });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

// ---------- F-099 ----------
const NEED_RE = /(필요|찾고|찾는|구하|구합|모집|원함|원합니다|원해|관심\s*있|도입\s*검토|looking for|need|seeking|wants? to|hiring|searching for)/i;

/** Sentences that state a need. Only text that literally contains a need cue is returned (never synthesized). */
export function extractNeedStatements(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\r?\n/)
    .map((s) => s.replace(/^[-*•\s]+/, "").trim())
    .filter((s) => s.length >= 4 && s.length <= 300 && NEED_RE.test(s));
}

export interface NeedItem {
  text: string;
  source: "profile_need" | "note" | "meeting";
  sourceId: string;
  personId: string;
  personName: string;
}
export interface OfferItem {
  text: string;
  personId: string;
  personName: string;
  kind: "contact" | "member" | "me";
}
export interface Opportunity {
  need: NeedItem;
  offer: OfferItem;
  score: number;
  reasons: string[];
  provenance: "ai_inferred";
}

export function detectOpportunities(needs: NeedItem[], offers: OfferItem[], limit = 30): Opportunity[] {
  const out: Opportunity[] = [];
  for (const n of needs) {
    for (const o of offers) {
      if (o.personId === n.personId) continue;
      const s = textSimilarity(n.text, o.text);
      if (s <= 0.2) continue;
      out.push({
        need: n,
        offer: o,
        score: Math.round(Math.min(1, s * 1.4) * 100) / 100,
        reasons: [`${n.personName}: “${n.text}” (${n.source === "profile_need" ? "카드 Need" : n.source === "note" ? "메모" : "미팅 기록"})`, `${o.personName}의 Offer “${o.text}”`],
        provenance: "ai_inferred",
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- F-133 layout (deterministic force-directed, Fruchterman–Reingold) ----------
export interface GNode {
  id: string;
  kind?: string;
}
export interface GEdge {
  source: string;
  target: string;
  weight?: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function forceLayout(nodes: GNode[], edges: GEdge[], opts: { width?: number; height?: number; iterations?: number; seed?: number } = {}): Record<string, { x: number; y: number }> {
  const W = opts.width ?? 800;
  const H = opts.height ?? 600;
  const n = nodes.length;
  if (!n) return {};
  const rand = rng(opts.seed ?? 42);
  const k = Math.sqrt((W * H) / n) * 0.75;
  const pos = nodes.map(() => ({ x: W * 0.1 + rand() * W * 0.8, y: H * 0.1 + rand() * H * 0.8 }));
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const E = edges.map((e) => [idx.get(e.source), idx.get(e.target), e.weight ?? 1] as const).filter((e): e is readonly [number, number, number] => e[0] !== undefined && e[1] !== undefined);
  const iters = opts.iterations ?? Math.min(300, 60 + n * 2);
  let t = W / 10;
  for (let it = 0; it < iters; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          d = 0.5;
        }
        const f = (k * k) / d;
        disp[i]!.x += (dx / d) * f;
        disp[i]!.y += (dy / d) * f;
        disp[j]!.x -= (dx / d) * f;
        disp[j]!.y -= (dy / d) * f;
      }
    }
    for (const [a, b, w] of E) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = ((d * d) / k) * (0.5 + Math.min(1, w));
      disp[a]!.x -= (dx / d) * f;
      disp[a]!.y -= (dy / d) * f;
      disp[b]!.x += (dx / d) * f;
      disp[b]!.y += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      // gravity to center keeps disconnected components on screen
      disp[i]!.x += (W / 2 - pos[i]!.x) * 0.02 * k * 0.05;
      disp[i]!.y += (H / 2 - pos[i]!.y) * 0.02 * k * 0.05;
      const d = Math.max(0.01, Math.hypot(disp[i]!.x, disp[i]!.y));
      pos[i]!.x = Math.min(W - 20, Math.max(20, pos[i]!.x + (disp[i]!.x / d) * Math.min(d, t)));
      pos[i]!.y = Math.min(H - 20, Math.max(20, pos[i]!.y + (disp[i]!.y / d) * Math.min(d, t)));
    }
    t = Math.max(0.5, t * 0.97);
  }
  return Object.fromEntries(nodes.map((nd, i) => [nd.id, { x: Math.round(pos[i]!.x * 10) / 10, y: Math.round(pos[i]!.y * 10) / 10 }]));
}
