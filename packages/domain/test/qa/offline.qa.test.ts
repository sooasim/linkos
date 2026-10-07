// QA (generated): F-052/F-178/F-179 offline outbox (ordering, idempotency, coalescing while in flight) ·
// F-052 offline pass/receipt signatures · F-039/F-040 BLE proximity ids · F-046 rendezvous codes · F-047 acoustic codec ·
// pure-TS SHA-256/HMAC vs node:crypto.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACOUSTIC_PREAMBLE,
  type OfflinePassClaims,
  type OutboxItem,
  type ReplayResponse,
  backoffMs,
  checkReceiptWindow,
  classifyRequest,
  createOutboxItem,
  decide,
  decodeAcousticFrame,
  decodeAcousticSamples,
  encodeAcousticFrame,
  enqueue,
  ephemeralIdToServiceUuid,
  evaluateProximity,
  fromBase64Url,
  generateEphemeralId,
  generateShortCode,
  hmacSha256Base64Url,
  normalizeRendezvousCode,
  parseOfflinePass,
  parseOfflineReceipt,
  readyItems,
  serviceUuidToEphemeralId,
  settle,
  sha256Bytes,
  signOfflinePass,
  signOfflineReceipt,
  synthesizeAcoustic,
  toBase64Url,
  toHex,
  verifyOfflinePass,
  verifyOfflineReceiptSignature,
} from "../../src";
import { type Rng, cases, rng } from "./_gen";

// ---------------- outbox simulation ----------------
const CONTACTS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const FIELDS = ["jobTitle", "company", "phone", "department"];

interface Server {
  contacts: Map<string, Record<string, unknown>>;
  notes: Map<string, string[]>;
  created: Map<string, number>;
  keys: Map<string, string>;
  violations: string[];
}

type Net = "ok" | "lost" | "down" | "500" | "429";

function serverHandle(srv: Server, item: OutboxItem, net: Net): ReplayResponse {
  if (net === "down") return { networkError: true };
  if (net === "500") return { status: 503, body: { code: "unavailable" } };
  if (net === "429") return { status: 429, body: { code: "rate_limited" }, retryAfterSec: 3 };
  const hash = JSON.stringify(item.body);
  const seen = srv.keys.get(item.idempotencyKey);
  if (seen !== undefined && seen !== hash) {
    srv.violations.push(`key ${item.idempotencyKey} reused with a different body`);
    return net === "lost" ? { networkError: true } : { status: 409, body: { code: "idempotency_key_reused" } };
  }
  if (seen === undefined) {
    srv.keys.set(item.idempotencyKey, hash);
    const body = item.body as Record<string, unknown>;
    const m = /^\/contacts\/([0-9a-f-]{36})(\/notes)?$/.exec(item.path);
    if (item.path === "/contacts") srv.created.set(String(body.cid), (srv.created.get(String(body.cid)) ?? 0) + 1);
    else if (m && m[2]) srv.notes.get(m[1]!)!.push(String(body.body));
    else if (m) Object.assign(srv.contacts.get(m[1]!)!, body);
  }
  return net === "lost" ? { networkError: true } : { status: 200, body: {} };
}

interface Expect {
  fields: Map<string, Record<string, unknown>>;
  notes: Map<string, string[]>;
  creates: string[];
}

function simulate(seed: number) {
  const r = rng(seed);
  const srv: Server = { contacts: new Map(CONTACTS.map((c) => [c, {}])), notes: new Map(CONTACTS.map((c) => [c, []])), created: new Map(), keys: new Map(), violations: [] };
  const exp: Expect = { fields: new Map(CONTACTS.map((c) => [c, {}])), notes: new Map(CONTACTS.map((c) => [c, []])), creates: [] };
  let items: OutboxItem[] = [];
  let now = 1_000_000;
  let seq = 0;
  const userWrite = () => {
    seq++;
    const kind = r.int(0, 3);
    const c = r.pick(CONTACTS);
    let method = "PATCH";
    let path = `/contacts/${c}`;
    let body: Record<string, unknown>;
    if (kind === 0) {
      method = "POST";
      path = "/contacts";
      body = { cid: `new-${seq}`, fullName: `N${seq}` };
      exp.creates.push(`new-${seq}`);
    } else if (kind === 1) {
      method = "POST";
      path = `/contacts/${c}/notes`;
      body = { body: `note-${seq}` };
      exp.notes.get(c)!.push(`note-${seq}`);
    } else {
      body = Object.fromEntries(r.subset(FIELDS).concat(r.pick(FIELDS)).map((f) => [f, `${f}-${seq}`]));
      Object.assign(exp.fields.get(c)!, body);
    }
    const it = createOutboxItem({ id: `id-${seq}`, method, path, body, idempotencyKey: `key-${seq}`, now: now++ });
    expect(it).not.toBeNull();
    items = enqueue(items, it!);
  };
  // flush exactly like apps/web/src/lib/offline.ts: send → (user may write meanwhile) → decide → settle on the stored record
  const flush = (netFor: () => Net) => {
    for (const item of readyItems(items, now)) {
      if (r.bool(0.35)) userWrite(); // the user keeps editing while this request is in flight
      const res = serverHandle(srv, item, netFor());
      const d = decide(item, res, now, r.next());
      const s = settle(items.find((x) => x.id === item.id), item, d);
      if (s.action === "delete") items = items.filter((x) => x.id !== item.id);
      else if (s.action === "put") items = items.map((x) => (x.id === item.id ? s.item : x));
      if ("networkError" in res) break;
    }
  };
  for (let round = 0; round < 40; round++) {
    for (let k = r.int(0, 3); k > 0; k--) userWrite();
    if (round < 8) flush(() => r.pick(["ok", "ok", "lost", "down", "500", "429"] as const));
    now += 10 * 60_000;
  }
  for (let round = 0; round < 200 && items.length; round++) {
    flush(() => "ok");
    now += 10 * 60_000;
  }
  return { srv, exp, items };
}

describe("QA · offline outbox simulation (300 seeded sessions, flaky network, edits while in flight)", () => {
  it.each(cases(300, 2229, (r) => r.int(0, 1e9)))("session #$i converges to the user's intent exactly once", ({ c: seed }) => {
    const { srv, exp, items } = simulate(seed);
    expect(srv.violations).toEqual([]); // an Idempotency-Key always identifies exactly one request body
    expect(items.filter((x) => x.status !== "pending")).toEqual([]);
    expect(items).toEqual([]);
    for (const cid of exp.creates) expect(srv.created.get(cid), cid).toBe(1); // created exactly once despite retries
    for (const c of CONTACTS) {
      expect(srv.contacts.get(c)).toEqual(exp.fields.get(c)); // no PATCH field lost or reordered
      expect(srv.notes.get(c)).toEqual(exp.notes.get(c)); // notes once each, in order
    }
  });

  it.each(cases(300, 2230, (r) => Array.from({ length: r.int(1, 25) }, (_, k) => ({ id: `i${k}`, entityKey: r.pick(["a", "b", "c", `new:${k}`]), createdAt: r.int(0, 50), nextAttemptAt: r.int(0, 100), status: r.pick(["pending", "pending", "conflict", "failed"] as const) }))))(
    "readyItems #$i: one per entity, oldest first, blocked behind unresolved writes",
    ({ c }) => {
      const ready = readyItems(c as unknown as OutboxItem[], 50);
      const ents = ready.map((x) => x.entityKey);
      expect(new Set(ents).size).toBe(ents.length);
      for (let k = 1; k < ready.length; k++) expect(ready[k - 1]!.createdAt).toBeLessThanOrEqual(ready[k]!.createdAt);
      for (const it of ready) {
        expect(it.status).toBe("pending");
        expect(it.nextAttemptAt).toBeLessThanOrEqual(50);
        expect(c.some((o) => o.entityKey === it.entityKey && o.createdAt < it.createdAt)).toBe(false);
      }
    },
  );

  it.each(Array.from({ length: 20 }, (_, a) => a))("backoff attempt %i within ±20%% of 2s·2^(n-1) capped at 5min", (a) => {
    const base = Math.min(300_000, 2000 * 2 ** Math.max(0, a - 1));
    expect(backoffMs(a, 0)).toBe(Math.round(base * 0.8));
    expect(backoffMs(a, 0.999999)).toBeLessThanOrEqual(Math.round(base * 1.2));
  });

  it.each([
    ["POST", "/contacts", "contact"], ["post", "/contacts?x=1", "contact"], ["PATCH", `/contacts/${CONTACTS[0]}`, "contact_update"], ["POST", "/capture/commit", "scan"], ["DELETE", `/contacts/${CONTACTS[0]}`, null], ["GET", "/contacts", null], ["POST", "/auth/otp", null], ["PATCH", "/contacts/../admin", null], ["POST", `/contacts/${CONTACTS[0]}/notes/../../x`, null],
  ])("classify %s %s → %s", (m, p, kind) => expect(classifyRequest(m, p)?.kind ?? null).toBe(kind));

  it.each([200, 201, 204, 400, 401, 403, 404, 408, 409, 410, 413, 422, 429, 500, 502, 503])("decide on HTTP %i", (status) => {
    const it0 = createOutboxItem({ id: "x", method: "POST", path: "/contacts", body: {}, idempotencyKey: "k", now: 0 })!;
    const d = decide(it0, { status, body: { code: status === 409 ? "version_conflict" : undefined } }, 0);
    const expected = status < 300 ? "done" : status === 409 ? "conflict" : [408, 429, 401].includes(status) || status >= 500 ? "retry" : "failed";
    expect(d.action).toBe(expected);
    if (d.action !== "done") expect(d.item.idempotencyKey).toBe("k"); // retries keep the key
  });
});

// ---------------- offline pass / receipt ----------------
const SECRET = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));
const OTHER = toBase64Url(new Uint8Array(32).map((_, i) => 255 - i));

describe("QA · offline pass & receipt signatures (300 generated)", () => {
  it.each(
    cases(300, 2331, (r): OfflinePassClaims => {
      const iat = 1_790_000_000_000 + r.int(0, 1e9);
      return { v: 1, k: r.str("abcdef0123456789", 8, 16), u: `u-${r.digits(6)}`, p: `p-${r.digits(6)}`, n: r.pick(["김민수", "Jane", "😀", "a\"b\\c", ""]), iat, exp: iat + r.int(0, 24 * 3600 * 1000), r: r.str("abc", 8, 8) };
    }),
  )("pass #$i: sign → verify, any tamper or wrong key fails", ({ c, i }) => {
    const pass = signOfflinePass(c, SECRET);
    expect(verifyOfflinePass(pass, SECRET)).toEqual(c);
    expect(verifyOfflinePass(pass, OTHER)).toBeNull();
    const pos = (i * 7919) % pass.length;
    const ch = pass[pos]!;
    const tampered = pass.slice(0, pos) + (ch === "A" ? "B" : "A") + pass.slice(pos + 1);
    if (tampered !== pass) expect(verifyOfflinePass(tampered, SECRET)).toBeNull();
    expect(parseOfflinePass(pass)?.claims).toEqual(c);
    const receipt = signOfflineReceipt({ v: 1, id: "123e4567-e89b-42d3-a456-426614174000", k: "dev", pass, at: c.iat + 1000, rc: i % 2 === 0 }, SECRET);
    expect(verifyOfflineReceiptSignature(receipt, SECRET)).toBe(true);
    expect(verifyOfflineReceiptSignature({ ...receipt, payload: receipt.payload + "x" }, SECRET)).toBe(false);
    expect(parseOfflineReceipt(receipt.payload)?.pass).toBe(pass);
    expect(checkReceiptWindow(parseOfflineReceipt(receipt.payload)!, c, c.u, c.iat + 2000)).toBe("self_exchange");
    expect(checkReceiptWindow(parseOfflineReceipt(receipt.payload)!, c, "someone-else", c.iat + 2000)).toBeNull();
  });
  it("refuses passes valid for more than 24h and short secrets", () => {
    expect(() => signOfflinePass({ v: 1, k: "k", u: "u", p: "p", n: "n", iat: 0, exp: 24 * 3600 * 1000 + 1, r: "r" }, SECRET)).toThrow();
    expect(() => signOfflinePass({ v: 1, k: "k", u: "u", p: "p", n: "n", iat: 0, exp: 1, r: "r" }, toBase64Url(new Uint8Array(16)))).toThrow();
  });
  it.each(["", "LKP1", "LKP1.e30.sig", "LKP1.!!!.x", "X.Y.Z", "LKP1.a.b.c", "x".repeat(5000)])("malformed pass %j is rejected", (s) => expect(verifyOfflinePass(s, SECRET)).toBeNull());
});

describe("QA · SHA-256 / HMAC / base64url vs node:crypto (500 generated)", () => {
  it.each(cases(500, 2432, (r) => ({ key: randomBytesFrom(r, r.int(0, 130)), msg: randomBytesFrom(r, r.int(0, 300)) })))("vector #$i", ({ c }) => {
    expect(toHex(sha256Bytes(c.msg))).toBe(createHash("sha256").update(c.msg).digest("hex"));
    const s = Buffer.from(c.msg).toString("latin1");
    expect(hmacSha256Base64Url(c.key, s)).toBe(createHmac("sha256", c.key).update(Buffer.from(s, "utf8")).digest("base64url"));
    expect(toBase64Url(c.msg)).toBe(Buffer.from(c.msg).toString("base64url"));
    expect(Buffer.from(fromBase64Url(toBase64Url(c.msg))!)).toEqual(Buffer.from(c.msg));
  });
  it("random large inputs", () => {
    for (const n of [55, 56, 63, 64, 65, 1000, 100_000]) {
      const b = randomBytes(n);
      expect(toHex(sha256Bytes(b))).toBe(createHash("sha256").update(b).digest("hex"));
    }
  });
});

function randomBytesFrom(r: Rng, n: number): Uint8Array {
  return Uint8Array.from({ length: n }, () => r.int(0, 255));
}

// ---------------- pairing / acoustic ----------------
describe("QA · BLE proximity ids & rendezvous codes (500 generated)", () => {
  const ids = Array.from({ length: 500 }, () => generateEphemeralId());
  it.each(ids.map((id, i) => ({ i, id })))("ephemeral id #$i ↔ service UUID", ({ id }) => {
    const uuid = ephemeralIdToServiceUuid(id);
    expect(uuid).toMatch(/^4c4b4f53-0001-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(serviceUuidToEphemeralId(uuid)).toBe(id);
    expect(serviceUuidToEphemeralId(uuid.toUpperCase())).toBe(id);
  });
  it.each(cases(200, 2533, (r) => {
    const near = generateEphemeralId();
    const far = generateEphemeralId();
    const now = 100_000;
    const samples = [
      ...Array.from({ length: r.int(0, 6) }, () => ({ ephemeralId: near, rssi: -r.int(35, 70), at: now - r.int(0, 4000) })),
      ...Array.from({ length: r.int(0, 6) }, () => ({ ephemeralId: far, rssi: -r.int(40, 95), at: now - r.int(0, 4000) })),
      { ephemeralId: "not-hex", rssi: -10, at: now },
      { ephemeralId: near, rssi: 5, at: now },
      { ephemeralId: far, rssi: Number.NaN, at: now },
    ];
    return { samples, now };
  }))("proximity #$i never picks a device without enough strong samples", ({ c }) => {
    const res = evaluateProximity(c.samples, c.now);
    if (res.status === "found") {
      const strong = c.samples.filter((s) => s.ephemeralId === res.candidate.ephemeralId && s.rssi >= -62 && s.rssi < 0 && c.now - s.at <= 3000);
      expect(strong.length).toBeGreaterThanOrEqual(3);
    }
    if (res.status === "ambiguous") expect(res.candidates.length).toBeGreaterThanOrEqual(2);
  });
  it.each(["1234", "12-34", " 1 2 3 4 ", "１２３４", "123", "12345", "abcd", ""])("rendezvous code %j", (s) => {
    const n = normalizeRendezvousCode(s);
    if (n) expect(n).toMatch(/^\d{4}$/);
    expect(n).toBe(/^\d{4}$/.test(s.replace(/[\s-]/g, "")) ? s.replace(/[\s-]/g, "") : null);
  });
});

describe("QA · acoustic codec (F-047)", () => {
  const codes = Array.from({ length: 600 }, () => generateShortCode());
  it.each(codes.map((c, i) => ({ i, c })))("frame #$i round-trips and detects any single-symbol corruption", ({ c, i }) => {
    const f = encodeAcousticFrame(c);
    expect(f).toHaveLength(8);
    expect(f[0]).toBe(ACOUSTIC_PREAMBLE);
    expect(decodeAcousticFrame(f)).toBe(c);
    const r = rng(i);
    const noise = Array.from({ length: r.int(0, 12) }, () => r.int(0, 31));
    expect(decodeAcousticFrame([...noise.filter((x) => x !== ACOUSTIC_PREAMBLE), ...f, ...noise])).toBe(c);
    const pos = 1 + (i % 7);
    const bad = [...f];
    bad[pos] = (bad[pos]! + 1 + r.int(0, 29)) % 31;
    expect(decodeAcousticFrame(bad)).not.toBe(c);
    if (f[1] !== f[2]) {
      const swapped = [...f];
      [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
      expect(decodeAcousticFrame(swapped)).toBeNull(); // transpositions are caught
    }
  });
  it.each(codes.slice(0, 12).flatMap((c, i) => [44_100, 48_000].map((sr) => ({ c, sr, i }))))("PCM $c @ $sr Hz decodes (with noise)", ({ c, sr, i }) => {
    const pcm = synthesizeAcoustic(c, sr);
    const r = rng(i);
    for (let k = 0; k < pcm.length; k++) pcm[k] = pcm[k]! + (r.next() - 0.5) * 0.05;
    expect(decodeAcousticSamples(pcm, sr)).toBe(c);
  });
});
