// QA (generated): F-010/F-013 imaging geometry (hull, quad, homography, card detection) · F-087/F-107 scheduling
// (time zones incl. DST, free slots) · F-181/F-196/F-188 flags, experiments, analytics props.
import { describe, expect, it } from "vitest";
import {
  type GrayImage,
  type Point,
  type Quad,
  applyHomography,
  assignVariant,
  computeFreeSlots,
  convexHull,
  detectCardQuad,
  downscale,
  evaluateFlag,
  experimentStats,
  hashBucket,
  homography,
  isConvexQuad,
  maxAreaQuad,
  orderQuad,
  otsuThreshold,
  overlaps,
  polygonArea,
  rectifiedSize,
  rgbaToGray,
  sanitizeProps,
  sequenceDueDates,
  validateWindows,
  zonedParts,
  zonedToUtc,
} from "../../src";
import { type Rng, cases } from "./_gen";

function convexQuad(r: Rng): Quad {
  // perturbed rectangle → always convex with a margin
  const cx = r.int(200, 800);
  const cy = r.int(200, 800);
  const w = r.int(60, 300);
  const h = r.int(40, 200);
  const a = r.next() * Math.PI;
  const j = () => r.next() * 10 - 5;
  const pts = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: cx + x! * Math.cos(a) - y! * Math.sin(a) + j(), y: cy + x! * Math.sin(a) + y! * Math.cos(a) + j() }));
  return pts as Quad;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

describe("QA · imaging geometry (400 generated quads/point clouds)", () => {
  it.each(cases(400, 2634, (r) => ({ src: convexQuad(r), dst: convexQuad(r), pts: Array.from({ length: r.int(3, 60) }, () => ({ x: r.int(0, 999), y: r.int(0, 999) })) })))("case #$i", ({ c }) => {
    // homography maps every corner exactly and round-trips through its inverse
    const H = homography(c.src, c.dst)!;
    const Hi = homography(c.dst, c.src)!;
    expect(H).not.toBeNull();
    c.src.forEach((p, k) => {
      const q = applyHomography(H, p);
      expect(q.x).toBeCloseTo(c.dst[k]!.x, 4);
      expect(q.y).toBeCloseTo(c.dst[k]!.y, 4);
    });
    const mid = { x: (c.src[0].x + c.src[2].x) / 2, y: (c.src[0].y + c.src[2].y) / 2 };
    const back = applyHomography(Hi, applyHomography(H, mid));
    expect(back.x).toBeCloseTo(mid.x, 3);
    expect(back.y).toBeCloseTo(mid.y, 3);
    // orderQuad: a permutation, convex, TL first (min x+y), same orientation for every input order
    const ordered = orderQuad([...c.src].reverse());
    expect(new Set(ordered.map((p) => `${p.x},${p.y}`))).toEqual(new Set(c.src.map((p) => `${p.x},${p.y}`)));
    expect(isConvexQuad(ordered)).toBe(true);
    expect(Math.min(...ordered.map((p) => p.x + p.y))).toBe(ordered[0].x + ordered[0].y);
    expect(Math.sign(cross(ordered[0], ordered[1], ordered[2]))).toBe(1); // clockwise on screen (y down)
    const size = rectifiedSize(ordered, 500);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(500);
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(1);
    // hull contains every point and is convex; the best quad is no larger than the hull
    const hull = convexHull(c.pts);
    for (let k = 0; hull.length >= 3 && k < hull.length; k++) {
      const a = hull[k]!;
      const b = hull[(k + 1) % hull.length]!;
      for (const p of c.pts) expect(cross(a, b, p)).toBeGreaterThanOrEqual(-1e-9);
    }
    const q = maxAreaQuad(hull);
    if (hull.length >= 4) {
      expect(q).not.toBeNull();
      expect(polygonArea(q!)).toBeLessThanOrEqual(polygonArea(hull) + 1e-6);
      for (const v of q!) expect(hull).toContainEqual(v);
    } else expect(q).toBeNull();
  });

  it.each(cases(200, 2635, (r) => Array.from({ length: r.int(1, 500) }, () => (r.bool(0.5) ? r.int(0, 80) : r.int(170, 255)))))("otsu #$i within range", ({ c }) => {
    const t = otsuThreshold(c);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(255);
  });

  it.each(cases(30, 2636, (r) => ({ w: r.int(1, 64), h: r.int(1, 64), max: r.int(1, 80) })))("gray/downscale #$i", ({ c }) => {
    const rgba = new Uint8ClampedArray(c.w * c.h * 4).fill(200);
    const g = rgbaToGray(rgba, c.w, c.h);
    expect(g.data.length).toBe(c.w * c.h);
    const d = downscale(g, c.max);
    expect(Math.max(d.img.width, d.img.height)).toBeLessThanOrEqual(Math.max(c.max, 1));
    expect(d.scale).toBeLessThanOrEqual(1);
    expect(d.img.data.length).toBe(d.img.width * d.img.height);
  });
});

function renderCard(r: Rng, W: number, H: number): { img: GrayImage; quad: Quad } {
  const cx = W / 2 + r.int(-40, 40);
  const cy = H / 2 + r.int(-30, 30);
  const w = r.int(110, 170);
  const h = Math.round(w * 0.58);
  const a = (r.next() - 0.5) * 0.7;
  const quad = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: cx + x! * Math.cos(a) - y! * Math.sin(a), y: cy + x! * Math.sin(a) + y! * Math.cos(a) })) as Quad;
  const data = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let inside = true;
      for (let k = 0; k < 4; k++) if (cross(quad[k]!, quad[(k + 1) % 4]!, { x, y }) < 0) inside = false;
      data[y * W + x] = (inside ? 225 : 45) + r.int(-12, 12);
    }
  return { img: { width: W, height: H, data }, quad };
}

describe("QA · card outline detection on 24 synthetic photos", () => {
  it.each(cases(24, 2737, (r) => renderCard(r, 480, 360)))("photo #$i corners within 4% of the card diagonal", ({ c }) => {
    const det = detectCardQuad(c.img);
    expect(det).not.toBeNull();
    const diag = Math.hypot(c.quad[0].x - c.quad[2].x, c.quad[0].y - c.quad[2].y);
    const truth = orderQuad(c.quad);
    det!.quad.forEach((p, k) => expect(Math.hypot(p.x - truth[k]!.x, p.y - truth[k]!.y)).toBeLessThan(diag * 0.04));
    expect(det!.confidence).toBeGreaterThan(0);
    expect(det!.confidence).toBeLessThanOrEqual(1);
  });
});

const ZONES = ["Asia/Seoul", "Asia/Tokyo", "America/Los_Angeles", "America/New_York", "Europe/Berlin", "Europe/London", "Australia/Sydney", "Asia/Kolkata", "America/Sao_Paulo", "Pacific/Auckland", "UTC", "Asia/Kathmandu", "America/St_Johns", "Pacific/Chatham"];

describe(`QA · time zones (${ZONES.length} zones × 40 wall-clock times)`, () => {
  it.each(ZONES.flatMap((tz, zi) => cases(40, 2838 + zi, (r) => ({ tz, y: r.pick([2025, 2026, 2027]), m: r.int(1, 12), d: r.int(1, 28), min: r.int(0, 1439) })).map((x) => x.c)))("$tz $y-$m-$d +$min min", ({ tz, y, m, d, min }) => {
    const utc = zonedToUtc(y, m, d, min, tz);
    const p = zonedParts(utc, tz);
    const got = p.hour * 60 + p.minute;
    if (p.year === y && p.month === m && p.day === d && got === min) return; // exact
    // only acceptable mismatch: a wall-clock time that does not exist (spring-forward gap) shifts by the gap (≤ 60 min)
    const delta = Date.UTC(p.year, p.month - 1, p.day, 0, got) - Date.UTC(y, m - 1, d, 0, min);
    expect(Math.abs(delta)).toBeLessThanOrEqual(60 * 60_000);
    expect(delta).not.toBe(0);
  });

  it.each(cases(200, 2939, (r) => ({
    tz: r.pick(ZONES),
    from: new Date(Date.UTC(2026, r.int(0, 11), r.int(1, 28), r.int(0, 23))),
    days: r.int(1, 14),
    durationMin: r.pick([15, 30, 45, 60, 90]),
    bufferMin: r.pick([0, 10, 15]),
    minNoticeMin: r.pick([0, 60, 240]),
    windows: r.subset([0, 1, 2, 3, 4, 5, 6]).map((weekday) => ({ weekday, start: r.int(6, 11) * 60, end: r.int(13, 20) * 60 })),
    busy: Array.from({ length: r.int(0, 8) }, () => {
      const s = Date.UTC(2026, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.pick([0, 15, 30, 45]));
      return { start: new Date(s), end: new Date(s + r.int(15, 180) * 60000) };
    }),
  })))("free slots #$i: inside windows, outside busy±buffer, after notice, sorted, non-overlapping", ({ c }) => {
    expect(validateWindows(c.windows)).toEqual([]);
    const now = c.from;
    const slots = computeFreeSlots({ ...c, now, limit: 200 });
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k]!;
      expect(s.end.getTime() - s.start.getTime()).toBe(c.durationMin * 60000);
      expect(s.start.getTime()).toBeGreaterThanOrEqual(now.getTime() + c.minNoticeMin * 60000);
      const b = c.bufferMin * 60000;
      for (const busy of c.busy) expect(overlaps(s, { start: new Date(busy.start.getTime() - b), end: new Date(busy.end.getTime() + b) })).toBe(false);
      const p = zonedParts(s.start, c.tz);
      const w = c.windows.filter((x) => x.weekday === p.weekday);
      const startMin = p.hour * 60 + p.minute;
      expect(w.some((x) => startMin >= x.start && startMin + c.durationMin <= x.end + 60), `${s.start.toISOString()} ${c.tz}`).toBe(true);
      if (k) expect(slots[k - 1]!.start.getTime()).toBeLessThan(s.start.getTime());
    }
  });

  it.each(cases(100, 3040, (r) => ({ tz: r.pick(ZONES), start: new Date(Date.UTC(2026, r.int(0, 11), r.int(1, 28), r.int(0, 23))), offsets: [0, ...r.subset([1, 2, 3, 5, 7, 14, 30])] })))("follow-up due dates #$i skip weekends", ({ c }) => {
    const due = sequenceDueDates(c.start, c.offsets, c.tz);
    expect(due).toHaveLength(c.offsets.length);
    due.forEach((d, k) => {
      expect(d.getTime()).toBeGreaterThanOrEqual(c.start.getTime());
      if (c.offsets[k]! > 0) expect([0, 6]).not.toContain(zonedParts(d, c.tz).weekday);
    });
  });
});

describe("QA · flags, experiments, analytics props", () => {
  it.each(cases(300, 3141, (r) => ({ key: r.str("abc", 1, 8), subject: r.str("0123456789abcdef-", 1, 36), p: r.int(0, 100), q: r.int(0, 100) })))("flag #$i: rollout is monotone and deterministic", ({ c }) => {
    const flag = (rolloutPercent: number) => ({ key: c.key, enabled: true, killed: false, rolloutPercent, allowUsers: [], allowOrgs: [], denyUsers: [] });
    const [lo, hi] = c.p <= c.q ? [c.p, c.q] : [c.q, c.p];
    const a = evaluateFlag(flag(lo), { userId: c.subject });
    const b = evaluateFlag(flag(hi), { userId: c.subject });
    if (a.on) expect(b.on).toBe(true); // raising the rollout never turns someone off
    expect(evaluateFlag(flag(lo), { userId: c.subject })).toEqual(a);
    expect(evaluateFlag({ ...flag(100), killed: true, allowUsers: [c.subject] }, { userId: c.subject }).on).toBe(false); // kill switch wins
    expect(evaluateFlag({ ...flag(100), denyUsers: [c.subject] }, { userId: c.subject }).on).toBe(false);
    const bucket = hashBucket(c.subject);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(10_000);
  });
  it.each(cases(100, 3142, (r) => ({ variants: Array.from({ length: r.int(1, 4) }, (_, k) => ({ key: `v${k}`, weight: r.pick([0, 1, 2, 5, -1]) })), traffic: r.pick([0, 10, 50, 100]), subjects: Array.from({ length: 50 }, () => r.str("abcdef0123456789", 8, 16)) })))("experiment #$i: deterministic, valid variant, zero-weight never chosen", ({ c }) => {
    const exp = { key: "e", variants: c.variants, trafficPercent: c.traffic };
    for (const s of c.subjects) {
      const v = assignVariant(exp, s);
      expect(assignVariant(exp, s)).toBe(v);
      if (v !== null) {
        expect(c.variants.map((x) => x.key)).toContain(v);
        expect(c.variants.find((x) => x.key === v)!.weight).toBeGreaterThan(0);
      }
      if (c.traffic === 0) expect(v).toBeNull();
    }
  });
  it.each(cases(100, 3143, (r) => Array.from({ length: r.int(1, 4) }, (_, k) => {
    const exposures = r.int(0, 5000);
    return { variant: `v${k}`, exposures, conversions: r.int(0, exposures) };
  })))("experimentStats #$i: rates and p-values are probabilities", ({ c }) => {
    for (const s of experimentStats(c)) {
      expect(s.rate).toBeGreaterThanOrEqual(0);
      expect(s.rate).toBeLessThanOrEqual(1);
      if (s.pValue !== null) {
        expect(s.pValue).toBeGreaterThanOrEqual(0);
        expect(s.pValue).toBeLessThanOrEqual(1);
      }
    }
  });
  it.each(cases(200, 3144, (r) => ({
    [r.pick(["email", "user_email", "phone", "name", "screen", "step", "ok", "Bad-Key", "count"])]: r.pick(["a@b.io", "010-1234-5678", "０１０－１２３４－５６７８", "home", 3, true, { x: 1 }, "x".repeat(100), Number.NaN]),
    screen: r.pick(["landing", "a@b.io"]),
  })))("sanitizeProps #$i drops PII", ({ c }) => {
    const out = sanitizeProps(c);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/@|010|０１０/);
    for (const k of Object.keys(out)) expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    for (const v of Object.values(out)) expect(["string", "number", "boolean"]).toContain(typeof v);
  });
});
