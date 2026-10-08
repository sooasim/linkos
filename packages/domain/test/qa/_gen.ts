// Deterministic generators for the generated QA suites (no Math.random: every run sees the same cases).
// Override the base seed with QA_SEED=<int> to explore new inputs locally; CI always uses the default.

export const BASE_SEED = Number(process.env.QA_SEED ?? 20261007);

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(p?: number): boolean;
  shuffle<T>(xs: readonly T[]): T[];
  digits(n: number): string;
  str(alphabet: string, min: number, max: number): string;
  subset<T>(xs: readonly T[]): T[];
}

/** mulberry32 — tiny, fast, good enough for test-case generation. */
export function rng(seed: number): Rng {
  let a = (seed ^ BASE_SEED) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  return {
    next,
    int,
    pick,
    bool: (p = 0.5) => next() < p,
    shuffle: <T>(xs: readonly T[]) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    digits: (n: number) => Array.from({ length: n }, () => String(int(0, 9))).join(""),
    str: (alphabet: string, min: number, max: number) => {
      const chars = [...alphabet];
      return Array.from({ length: int(min, max) }, () => pick(chars)).join("");
    },
    subset: <T>(xs: readonly T[]) => xs.filter(() => next() < 0.5),
  };
}

/** Build `n` cases with independent seeds so a failing case is reproducible by its index alone. */
export function cases<T>(n: number, salt: number, make: (r: Rng, i: number) => T): { i: number; c: T }[] {
  return Array.from({ length: n }, (_, i) => ({ i, c: make(rng(salt * 1_000_003 + i), i) }));
}

/** Cartesian product of option arrays. */
export function product<T extends Record<string, readonly unknown[]>>(dims: T): { [K in keyof T]: T[K][number] }[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vals] of Object.entries(dims)) {
    const next: Record<string, unknown>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next;
  }
  return out as { [K in keyof T]: T[K][number] }[];
}

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
