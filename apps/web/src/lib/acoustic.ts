"use client";
// F-047 음향 페어링 실험 (P3) — Web Audio glue only; encode/decode are pure functions in @linkos/domain.
// Enabled only when NEXT_PUBLIC_LINKOS_EXPERIMENT_ACOUSTIC=1. It transmits the 6-char short code (which still
// expires and resolves to the normal guest landing); it is not a P2P data channel.
import { decodeAcousticSamples, synthesizeAcoustic } from "@linkos/domain";

export const ACOUSTIC_EXPERIMENT = process.env.NEXT_PUBLIC_LINKOS_EXPERIMENT_ACOUSTIC === "1";

type AudioCtor = typeof AudioContext;
function audioCtor(): AudioCtor | null {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function acousticSupported(): boolean {
  return typeof window !== "undefined" && !!audioCtor() && !!navigator.mediaDevices?.getUserMedia;
}

/** Play the short code as near-ultrasonic FSK (≈17–19 kHz). Resolves when playback ends. */
export async function playShortCode(code: string): Promise<void> {
  const Ctor = audioCtor();
  if (!Ctor) throw new Error("unsupported");
  const ctx = new Ctor();
  try {
    const pcm = synthesizeAcoustic(code, ctx.sampleRate);
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** Record from the microphone for `seconds` and try to decode a short code. Returns null if nothing valid was heard. */
export async function listenForShortCode(seconds = 5, signal?: AbortSignal): Promise<string | null> {
  const Ctor = audioCtor();
  if (!Ctor) throw new Error("unsupported");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new Ctor();
  try {
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally available and enough for a short offline capture
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const total = Math.round(seconds * ctx.sampleRate);
    const out = new Float32Array(total);
    let filled = 0;
    await new Promise<void>((resolve) => {
      const stop = () => {
        proc.disconnect();
        src.disconnect();
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        const n = Math.min(ch.length, total - filled);
        out.set(ch.subarray(0, n), filled);
        filled += n;
        if (filled >= total) stop();
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    });
    return decodeAcousticSamples(out.subarray(0, filled), ctx.sampleRate);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
  }
}
