// Track E: F-039/F-040 근접, F-046 rendezvous, F-047 음향(실험), F-052 오프라인 영수증 — pure domain tests
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACOUSTIC_PREAMBLE,
  DEFAULT_CAPABILITIES,
  DEFAULT_PROXIMITY_POLICY,
  RENDEZVOUS_CONFIRM_MS,
  acousticChecksum,
  checkReceiptWindow,
  decodeAcousticFrame,
  decodeAcousticSamples,
  detectAcousticSymbols,
  encodeAcousticFrame,
  ephemeralIdToServiceUuid,
  evaluateProximity,
  fromBase64Url,
  generateEphemeralId,
  generateRendezvousCode,
  generateShortCode,
  generateVerifyCode,
  hmacSha256Bytes,
  isEphemeralId,
  normalizeRendezvousCode,
  parseOfflinePass,
  parseOfflineReceipt,
  planChannels,
  rendezvousStatusAt,
  serviceUuidToEphemeralId,
  sha256Bytes,
  signOfflinePass,
  signOfflineReceipt,
  synthesizeAcoustic,
  toBase64Url,
  toHex,
  verifyOfflinePass,
  verifyOfflineReceiptSignature,
  type OfflinePassClaims,
  generateExchangeCode,
} from "../src/index";

describe("pure SHA-256 / HMAC (Hermes-safe) matches node:crypto", () => {
  it("sha256 on edge lengths", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(len);
      expect(toHex(sha256Bytes(new Uint8Array(data)))).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
  it("hmac with short and long keys", () => {
    for (const klen of [16, 32, 64, 100]) {
      const key = randomBytes(klen);
      const msg = randomBytes(77);
      expect(toHex(hmacSha256Bytes(new Uint8Array(key), new Uint8Array(msg)))).toBe(createHmac("sha256", key).update(msg).digest("hex"));
    }
  });
  it("base64url roundtrip matches Buffer", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const b = randomBytes(len);
      const enc = toBase64Url(new Uint8Array(b));
      expect(enc).toBe(b.toString("base64url"));
      expect(Buffer.from(fromBase64Url(enc)!).equals(b)).toBe(true);
    }
    expect(fromBase64Url("a")).toBeNull();
    expect(fromBase64Url("ab$c")).toBeNull();
  });
});

describe("F-052 offline pass + receipt", () => {
  const senderSecret = randomBytes(32).toString("base64url");
  const receiverSecret = randomBytes(32).toString("base64url");
  const now = Date.now();
  const claims: OfflinePassClaims = { v: 1, k: "k_sender", u: "user-a", p: "profile-a", n: "홍길동", iat: now, exp: now + 3600_000, r: "nonce1" };

  it("signs and verifies a pass; rejects tampering and wrong key", () => {
    const pass = signOfflinePass(claims, senderSecret);
    expect(verifyOfflinePass(pass, senderSecret)).toMatchObject({ u: "user-a", n: "홍길동" });
    expect(verifyOfflinePass(pass, receiverSecret)).toBeNull();
    const parsed = parseOfflinePass(pass)!;
    const forged = `${parsed.body.split(".")[0]}.${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, u: "user-x" })))}.${parsed.sig}`;
    expect(verifyOfflinePass(forged, senderSecret)).toBeNull();
    expect(() => signOfflinePass({ ...claims, exp: now + 48 * 3600_000 }, senderSecret)).toThrow();
    expect(() => signOfflinePass(claims, "short")).toThrow();
  });

  it("node:crypto HMAC agrees with the domain signature (server parity)", () => {
    const pass = signOfflinePass(claims, senderSecret);
    const [p, b, sig] = pass.split(".");
    expect(createHmac("sha256", Buffer.from(senderSecret, "base64url")).update(`${p}.${b}`).digest("base64url")).toBe(sig);
  });

  it("signs a receipt and enforces the time window", () => {
    const pass = signOfflinePass(claims, senderSecret);
    const r = signOfflineReceipt({ v: 1, id: crypto.randomUUID(), k: "k_recv", pass, at: now + 1000, rc: true }, receiverSecret);
    expect(verifyOfflineReceiptSignature(r, receiverSecret)).toBe(true);
    expect(verifyOfflineReceiptSignature({ ...r, signature: r.signature.slice(0, -1) + (r.signature.endsWith("A") ? "B" : "A") }, receiverSecret)).toBe(false);
    const rc = parseOfflineReceipt(r.payload)!;
    expect(rc.pass).toBe(pass);
    expect(checkReceiptWindow(rc, claims, "user-b", now)).toBeNull();
    expect(checkReceiptWindow(rc, claims, "user-a", now)).toBe("self_exchange");
    expect(checkReceiptWindow({ ...rc, at: now + 2 * 3600_000 }, claims, "user-b", now + 2 * 3600_000)).toBe("pass_expired");
    expect(checkReceiptWindow({ ...rc, at: now + 3600_000 }, claims, "user-b", now)).toBe("receipt_in_future");
    expect(checkReceiptWindow(rc, claims, "user-b", now + 40 * 86400_000)).toBe("receipt_too_old");
    expect(parseOfflineReceipt("LKR1.!!!")).toBeNull();
    expect(parseOfflineReceipt(r.payload + ".x")).toBeNull();
  });

  it("offline ladder offers the local receipt before QR only for native apps", () => {
    expect(planChannels({ ...DEFAULT_CAPABILITIES, online: false, installedApp: true, nativeBle: true })).toEqual(["local_receipt", "qr"]);
    expect(planChannels({ ...DEFAULT_CAPABILITIES, online: false })).toEqual(["qr"]);
  });
});

describe("F-039/F-040 proximity", () => {
  it("encodes ephemeral ids into a BLE service UUID and back", () => {
    const eph = generateEphemeralId();
    expect(isEphemeralId(eph)).toBe(true);
    const uuid = ephemeralIdToServiceUuid(eph);
    expect(uuid).toMatch(/^4c4b4f53-0001-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(serviceUuidToEphemeralId(uuid.toUpperCase())).toBe(eph);
    expect(serviceUuidToEphemeralId("0000180f-0000-1000-8000-00805f9b34fb")).toBeNull();
    expect(() => ephemeralIdToServiceUuid("홍길동")).toThrow();
  });

  it("finds one close device, ignores far/stale ones, refuses ambiguous crowds", () => {
    const now = 10_000;
    const a = "aaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbb";
    const s = (id: string, rssi: number, at: number) => ({ ephemeralId: id, rssi, at });
    expect(evaluateProximity([], now).status).toBe("none");
    expect(evaluateProximity([s(b, -80, 9000), s(b, -82, 9500), s(b, -79, 9900)], now).status).toBe("none");
    const found = evaluateProximity([s(a, -45, 8000), s(a, -48, 9000), s(a, -44, 9900), s(b, -80, 9500), s(b, -78, 9600), s(b, -81, 9700)], now);
    expect(found).toMatchObject({ status: "found", candidate: { ephemeralId: a } });
    expect(evaluateProximity([s(a, -45, 1000), s(a, -45, 2000), s(a, -45, 3000)], now).status).toBe("none");
    expect(evaluateProximity([s(a, -50, 9000), s(a, -50, 9500), s(a, -50, 9900), s(b, -52, 9000), s(b, -51, 9500), s(b, -52, 9900)], now).status).toBe("ambiguous");
    expect(DEFAULT_PROXIMITY_POLICY.rssiThreshold).toBeLessThan(0);
  });

  it("verify codes are 4 digits", () => {
    for (let i = 0; i < 50; i++) expect(generateVerifyCode()).toMatch(/^\d{4}$/);
  });
});

describe("F-046 web rendezvous rules", () => {
  it("codes, normalization and expiry", () => {
    expect(generateRendezvousCode()).toMatch(/^\d{4}$/);
    expect(normalizeRendezvousCode(" 12-34 ")).toBe("1234");
    expect(normalizeRendezvousCode("12a4")).toBeNull();
    const now = new Date();
    expect(rendezvousStatusAt({ status: "waiting", expiresAt: new Date(now.getTime() - 1), matchedAt: null }, now)).toBe("expired");
    expect(rendezvousStatusAt({ status: "matched", expiresAt: new Date(now.getTime() + 1000), matchedAt: new Date(now.getTime() - RENDEZVOUS_CONFIRM_MS - 1) }, now)).toBe("expired");
    expect(rendezvousStatusAt({ status: "confirmed", expiresAt: new Date(0), matchedAt: null }, now)).toBe("confirmed");
  });
  it("web ladder offers rendezvous only when the receiver is on the web exchange screen", () => {
    expect(planChannels({ ...DEFAULT_CAPABILITIES, receiverMode: "web_exchange_screen" })[0]).toBe("web_rendezvous");
    expect(planChannels(DEFAULT_CAPABILITIES)).not.toContain("web_rendezvous");
  });
});

describe("F-047 acoustic FSK (experimental)", () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
  }

  it("frame encode/decode with checksum", () => {
    const code = generateExchangeCode();
    const frame = encodeAcousticFrame(code);
    expect(frame[0]).toBe(ACOUSTIC_PREAMBLE);
    expect(frame).toHaveLength(6);
    expect(decodeAcousticFrame(frame)).toBe(code);
    expect(decodeAcousticFrame([3, 7, ...frame, 1])).toBe(code);
    const bad = [...frame];
    bad[3] = (bad[3]! + 1) % 31;
    expect(decodeAcousticFrame(bad)).toBeNull();
    const data = frame.slice(1, 5);
    if (data[0] !== data[1]) {
      const swapped = [data[1]!, data[0]!, ...data.slice(2)];
      expect(acousticChecksum(swapped)).not.toBe(acousticChecksum(data));
    }
    expect(() => encodeAcousticFrame("12a4")).toThrow();
    expect(() => encodeAcousticFrame("ABC234")).toThrow();
  });

  it.each([48_000, 44_100])("synthesize → detect roundtrip at %i Hz with noise", (sr) => {
    const code = "0770"; // leading zero + a repeated symbol (77)
    const pcm = synthesizeAcoustic(code, sr, 2, 0.3);
    const r = rng(42);
    const lead = Math.round(sr / 4);
    const noisy = new Float32Array(pcm.length + 2 * lead);
    for (let i = 0; i < noisy.length; i++) {
      const speech = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.1 * Math.sin((2 * Math.PI * 1200 * i) / sr);
      const sig = i >= lead && i - lead < pcm.length ? pcm[i - lead]! : 0;
      noisy[i] = sig + speech + 0.05 * r();
    }
    expect(decodeAcousticSamples(noisy, sr)).toBe(code);
    expect(detectAcousticSymbols(noisy, sr).filter((s) => s === ACOUSTIC_PREAMBLE).length).toBeGreaterThanOrEqual(2);
  });

  it("pure noise decodes to nothing", () => {
    const r = rng(7);
    const noise = new Float32Array(48_000).map(() => 0.3 * r());
    expect(decodeAcousticSamples(noise, 48_000)).toBeNull();
  });
});
