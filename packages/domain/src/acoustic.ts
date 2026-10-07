// F-047 음향 페어링 실험 (P3, 실험 플래그 뒤): 6자리 단축코드를 근초음파 FSK 로 전송.
// 순수 함수만 — 합성(synthesize)과 복호(decode)는 샘플 배열을 입출력으로 받는다. Web Audio 연결은 UI 몫.
//
// Frame:  [PRE] [c0] [c1] [c2] [c3] [c4] [c5] [CHK]     (each symbol = tone, then silence gap)
//   - 32 tones: 0..30 = short-code alphabet index, 31 = preamble
//   - CHK = Σ (i+1)·idx(c_i) mod 31  → catches single-symbol errors and transpositions
//   - sender repeats the frame; the decoder returns the first frame whose checksum verifies.
// The short code itself still expires in 10 minutes and resolves to the normal guest landing,
// so a wrong/attacker tone can at worst open someone else's public card — it never exchanges anything.
import { normalizeShortCode } from "./token";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // must match token.ts SHORT_ALPHABET
export const ACOUSTIC_PREAMBLE = 31;
export const ACOUSTIC_BASE_HZ = 17_000;
export const ACOUSTIC_SPACING_HZ = 62.5;
export const ACOUSTIC_TONE_MS = 80;
export const ACOUSTIC_GAP_MS = 40;
export const ACOUSTIC_REPEATS = 3;

export function symbolFrequency(sym: number): number {
  if (!Number.isInteger(sym) || sym < 0 || sym > 31) throw new Error("symbol out of range");
  return ACOUSTIC_BASE_HZ + sym * ACOUSTIC_SPACING_HZ;
}

export function acousticChecksum(symbols: number[]): number {
  let s = 0;
  symbols.forEach((v, i) => (s += (i + 1) * v));
  return s % 31;
}

/** short code → symbol frame (preamble + 6 data + checksum) */
export function encodeAcousticFrame(code: string): number[] {
  const c = normalizeShortCode(code);
  if (!c) throw new Error("invalid short code");
  const data = [...c].map((ch) => ALPHABET.indexOf(ch));
  return [ACOUSTIC_PREAMBLE, ...data, acousticChecksum(data)];
}

/** symbol stream (may contain noise/partial frames) → first checksum-valid short code */
export function decodeAcousticFrame(symbols: number[]): string | null {
  for (let i = 0; i + 7 < symbols.length; i++) {
    if (symbols[i] !== ACOUSTIC_PREAMBLE) continue;
    const data = symbols.slice(i + 1, i + 7);
    const chk = symbols[i + 7]!;
    if (data.some((d) => d < 0 || d > 30)) continue;
    if (acousticChecksum(data) !== chk) continue;
    return data.map((d) => ALPHABET[d]).join("");
  }
  return null;
}

/** PCM synthesis (mono, -1..1). Raised-cosine ramps avoid audible clicks. */
export function synthesizeAcoustic(code: string, sampleRate: number, repeats = ACOUSTIC_REPEATS, amplitude = 0.6): Float32Array {
  const frame = encodeAcousticFrame(code);
  const tone = Math.round((ACOUSTIC_TONE_MS / 1000) * sampleRate);
  const gap = Math.round((ACOUSTIC_GAP_MS / 1000) * sampleRate);
  const ramp = Math.round(0.006 * sampleRate);
  const out = new Float32Array((tone + gap) * frame.length * repeats + gap);
  let off = gap;
  for (let r = 0; r < repeats; r++) {
    for (const sym of frame) {
      const w = (2 * Math.PI * symbolFrequency(sym)) / sampleRate;
      for (let n = 0; n < tone; n++) {
        const env = n < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * n) / ramp) : n > tone - ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (tone - n)) / ramp) : 1;
        out[off + n] = amplitude * env * Math.sin(w * n);
      }
      off += tone + gap;
    }
  }
  return out;
}

function goertzelPower(x: Float32Array, start: number, len: number, freq: number, sampleRate: number, win: Float32Array): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < len; n++) {
    const s0 = x[start + n]! * win[n]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Detect the symbol stream in a recorded buffer: sliding Goertzel over the 32 tones,
 * per-hop dominant tone gated by SNR and an absolute level relative to the loudest hop,
 * then run-length segmentation (silence gaps separate repeated symbols).
 */
export function detectAcousticSymbols(samples: Float32Array, sampleRate: number): number[] {
  const winLen = Math.round(0.024 * sampleRate);
  const hop = Math.round(0.006 * sampleRate);
  if (samples.length < winLen) return [];
  const win = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (winLen - 1));
  const freqs = Array.from({ length: 32 }, (_, i) => symbolFrequency(i));
  const hops: { sym: number; power: number }[] = [];
  for (let start = 0; start + winLen <= samples.length; start += hop) {
    const p = freqs.map((f) => goertzelPower(samples, start, winLen, f, sampleRate, win));
    let best = 0;
    for (let i = 1; i < 32; i++) if (p[i]! > p[best]!) best = i;
    const others = p.filter((_, i) => i !== best).sort((a, b) => a - b);
    const med = others[others.length >> 1]!;
    const second = others[others.length - 1]!;
    const snrOk = p[best]! > 8 * (med + 1e-12) && p[best]! > 2 * second;
    hops.push({ sym: snrOk ? best : -1, power: snrOk ? p[best]! : 0 });
  }
  const peak = hops.reduce((m, h) => Math.max(m, h.power), 0);
  if (peak <= 0) return [];
  const gate = peak * 0.12;
  const seq = hops.map((h) => (h.power >= gate ? h.sym : -1));
  // run-length segmentation
  const minRun = Math.max(2, Math.floor((ACOUSTIC_TONE_MS * 0.4) / 6));
  const out: number[] = [];
  let cur = -1;
  let run = 0;
  const flush = () => {
    if (cur >= 0 && run >= minRun) out.push(cur);
  };
  for (const s of seq) {
    if (s === cur) run++;
    else {
      flush();
      cur = s;
      run = 1;
    }
  }
  flush();
  return out;
}

export function decodeAcousticSamples(samples: Float32Array, sampleRate: number): string | null {
  return decodeAcousticFrame(detectAcousticSymbols(samples, sampleRate));
}
