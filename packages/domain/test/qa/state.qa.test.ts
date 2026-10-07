// QA (generated): F-034 field ACL matrix · 백서 3.1 exchange state machine · 백서 19 introduction state machine ·
// 백서 16 handoff ladder (CLAUDE.md rules 3–4: QR is the final fallback, never browser BLE/NFC P2P).
import { describe, expect, it } from "vitest";
import {
  type Audience,
  type CapabilityVector,
  type Channel,
  EXCHANGE_STATES,
  type ExchangeState,
  INTRO_STATES,
  type IntroState,
  VISIBILITY_LEVELS,
  type Visibility,
  acceptsReply,
  canIntroTransition,
  canSee,
  canTransition,
  contactsRevealed,
  filterFieldsByAudience,
  hiddenFieldCount,
  isCompleted,
  isTerminal,
  nextChannel,
  planChannels,
  transition,
} from "../../src";
import { cases, product, rng } from "./_gen";

const AUDIENCES: Audience[] = ["public", "business", "trusted", "partner", "owner"];
const AUD_RANK: Record<Audience, number> = { public: 0, business: 1, trusted: 2, partner: 3, owner: 4 };
const VIS_RANK: Record<Visibility, number> = { public: 0, business: 1, trusted: 2, partner: 3, private: 99 };

describe("QA · ACL canSee exhaustive matrix (5 visibilities × 5 audiences)", () => {
  it.each(product({ field: VISIBILITY_LEVELS, audience: AUDIENCES }))("$field visible to $audience?", ({ field, audience }) => {
    const expected = audience === "owner" || (field !== "private" && VIS_RANK[field] <= AUD_RANK[audience]);
    expect(canSee(field, audience)).toBe(expected);
  });
});

const FIELD_LISTS = cases(300, 808, (r) => Array.from({ length: r.int(0, 12) }, (_, k) => ({ id: k, visibility: r.pick(VISIBILITY_LEVELS) })));

describe("QA · filterFieldsByAudience (300 generated field lists)", () => {
  it.each(FIELD_LISTS)("list #$i: monotone in audience, private only for owner, order kept", ({ c }) => {
    let prev: number[] = [];
    for (const a of AUDIENCES) {
      const seen = filterFieldsByAudience(c, a).map((f) => f.id);
      for (const id of prev) expect(seen).toContain(id); // wider audience never sees less
      expect(seen).toEqual([...seen].sort((x, y) => x - y)); // stable order
      if (a !== "owner") expect(c.filter((f) => seen.includes(f.id)).some((f) => f.visibility === "private")).toBe(false);
      expect(hiddenFieldCount(c, a)).toBe(c.length - seen.length);
      prev = seen;
    }
    expect(prev.length).toBe(c.length); // owner sees all
  });
});

// ---------------- exchange state machine ----------------
const COMPLETED = new Set<ExchangeState>(["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"]);
const KILL = new Set<ExchangeState>(["EXPIRED", "REVOKED", "CANCELLED"]);

describe("QA · exchange transitions (all 14 × 14 pairs)", () => {
  it.each(product({ from: EXCHANGE_STATES, to: EXCHANGE_STATES }))("$from → $to", ({ from, to }) => {
    const ok = canTransition(from, to);
    if (from === to) expect(ok).toBe(true);
    else {
      if (isTerminal(from)) expect(ok).toBe(false); // nothing leaves a terminal state
      if (COMPLETED.has(from) && !COMPLETED.has(to)) expect(ok).toBe(false); // a completed exchange never "un-completes"
      if (COMPLETED.has(from) && KILL.has(to)) expect(ok).toBe(false); // nor can it be revoked/expired afterwards
      if (to === "CLAIMED") expect(ok).toBe(from === "EXCHANGED" || from === "CLAIM_PENDING"); // claim only after exchange (rule 2)
      if (to === "EXCHANGED") expect(ok).toBe(from === "RECEIVER_OPENED" || from === "CONSENT_PENDING"); // only after the receiver opened
      if (!isTerminal(from) && !COMPLETED.has(from) && KILL.has(to)) expect(ok).toBe(true); // open sessions can always be killed
    }
    if (ok) expect(transition(from, to)).toBe(to);
    else expect(() => transition(from, to)).toThrow(/invalid exchange transition/);
  });

  it("every state is reachable from CREATED", () => {
    const seen = new Set<ExchangeState>(["CREATED"]);
    const queue: ExchangeState[] = ["CREATED"];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of EXCHANGE_STATES) if (!seen.has(t) && canTransition(s, t)) (seen.add(t), queue.push(t));
    }
    expect([...seen].sort()).toEqual([...EXCHANGE_STATES].sort());
  });
});

const WALKS = cases(12, 909, (r) => r.int(0, 1e9));

describe("QA · exchange random walks (12 × 5,000 steps)", () => {
  it.each(WALKS)("walk #$i never reaches an illegal state", ({ c: seed }) => {
    const r = rng(seed);
    let s: ExchangeState = "CREATED";
    let completed = false;
    let killed = false;
    const now = new Date("2026-10-07T00:00:00Z");
    for (let step = 0; step < 5000; step++) {
      const to = r.pick(EXCHANGE_STATES);
      if (canTransition(s, to)) s = transition(s, to);
      else expect(() => transition(s, to)).toThrow();
      if (COMPLETED.has(s)) completed = true;
      if (KILL.has(s)) killed = true;
      if (completed) expect(COMPLETED.has(s)).toBe(true);
      if (killed) expect(KILL.has(s)).toBe(true);
      expect(completed && killed).toBe(false);
      expect(isCompleted(s)).toBe(COMPLETED.has(s));
      // replies are only accepted on open, unexpired sessions
      expect(acceptsReply(s, new Date(now.getTime() + 60_000), now)).toBe(!completed && !killed);
      expect(acceptsReply(s, now, now)).toBe(false);
      if (isTerminal(s) && r.bool(0.05)) s = "CREATED"; // restart a fresh session to keep exploring
      if (s === "CREATED") (completed = false), (killed = false);
    }
  });
});

// ---------------- introduction state machine ----------------
const BOTH_ACCEPTED_OR_LATER = new Set<IntroState>(["PARTY_B_ACCEPTED", "ROOM_CREATED", "MEETING_BOOKED", "ACTIVE", "WON"]);

describe("QA · introduction transitions (9 × 9 pairs)", () => {
  it.each(product({ from: INTRO_STATES, to: INTRO_STATES }))("$from → $to", ({ from, to }) => {
    const ok = canIntroTransition(from, to);
    if (from === "ARCHIVED" || from === "DECLINED") expect(ok).toBe(false);
    if (to === "ROOM_CREATED") expect(ok).toBe(from === "PARTY_B_ACCEPTED"); // room only after BOTH accepted
    if (to === "PARTY_B_ACCEPTED") expect(ok).toBe(from === "PARTY_A_ACCEPTED");
    if (BOTH_ACCEPTED_OR_LATER.has(from)) expect(to === "DECLINED" && ok).toBe(false);
    expect(ok && from === to).toBe(false); // no self loops
  });
});

describe("QA · introduction random walks (10 × 2,000 steps)", () => {
  it.each(cases(10, 1010, (r) => r.int(0, 1e9)))("walk #$i: contacts never revealed before both accept", ({ c: seed }) => {
    const r = rng(seed);
    let s: IntroState = "INTRO_PROPOSED";
    let bothAccepted = false;
    for (let step = 0; step < 2000; step++) {
      const to = r.pick(INTRO_STATES);
      if (canIntroTransition(s, to)) s = to;
      if (s === "PARTY_B_ACCEPTED") bothAccepted = true;
      if (contactsRevealed(s)) expect(bothAccepted).toBe(true);
      if (s === "ARCHIVED" || s === "DECLINED") {
        s = "INTRO_PROPOSED";
        bothAccepted = false;
      }
    }
  });
});

// ---------------- handoff ladder ----------------
const BOOLS = [false, true] as const;
const CAPS: CapabilityVector[] = product({
  installedApp: BOOLS,
  nativeBle: BOOLS,
  receiverHasApp: [null, false, true] as const,
  webShare: BOOLS,
  appClipEntry: BOOLS,
  nfcAccessoryEnabled: BOOLS,
  camera: BOOLS,
  online: BOOLS,
  pwaInstalled: BOOLS,
  receiverMode: ["unknown", "nearby_app", "web_exchange_screen"] as const,
  experimentalAcoustic: BOOLS,
});

describe(`QA · handoff ladder (${CAPS.length} capability combinations)`, () => {
  it.each(CAPS.map((cap, i) => ({ i, cap })))("capabilities #$i", ({ cap }) => {
    const ladder = planChannels(cap);
    expect(ladder.at(-1)).toBe("qr"); // QR always present and always last
    expect(ladder.filter((c) => c === "qr")).toHaveLength(1);
    expect(new Set(ladder).size).toBe(ladder.length);
    if (ladder.length > 1) expect(ladder[0]).not.toBe("qr"); // rule 3: never QR first while another channel exists
    // rule 4: BLE only between native apps; web never gets phone↔phone P2P
    if (ladder.includes("ble_proximity")) expect(cap.installedApp && cap.nativeBle).toBe(true);
    if (ladder.includes("local_receipt")) expect(cap.installedApp && cap.nativeBle && !cap.online).toBe(true);
    if (ladder.includes("web_rendezvous")) expect(cap.receiverMode).toBe("web_exchange_screen");
    if (ladder.includes("nfc_accessory")) expect(cap.nfcAccessoryEnabled).toBe(true);
    if (ladder.includes("acoustic")) expect(cap.experimentalAcoustic).toBe(true);
    if (ladder.includes("os_share")) expect(cap.webShare || cap.installedApp).toBe(true);
    if (!cap.online) expect(ladder.every((c) => c === "qr" || c === "local_receipt")).toBe(true);
    else {
      expect(ladder).toContain("short_code"); // online: a typed code always exists before QR
      if (cap.webShare) expect(ladder.indexOf("os_share")).toBeLessThan(ladder.indexOf("qr"));
    }
    // failover walk: every failure advances, QR is absorbing, success ends the exchange
    let ch: Channel = ladder[0]!;
    const visited: Channel[] = [ch];
    for (let k = 0; k < ladder.length + 3; k++) {
      expect(nextChannel(ladder, ch, "success")).toBeNull();
      const n = nextChannel(ladder, ch, k % 2 ? "failed" : "timeout");
      expect(n).not.toBeNull();
      if (ch !== "qr") expect(ladder.indexOf(n!)).toBe(ladder.indexOf(ch) + 1);
      ch = n!;
      visited.push(ch);
    }
    expect(ch).toBe("qr");
    expect(nextChannel(ladder, "acoustic" as Channel, "failed")).toBe(ladder.includes("acoustic") ? ladder[ladder.indexOf("acoustic") + 1] : "qr");
  });
});
