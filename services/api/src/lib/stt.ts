// F-082 전사 + 언어 감지 / F-083 화자분리: STT provider adapters selected by STT_PROVIDER.
//  - google : Google Cloud Speech-to-Text v2 REST (recognizers/_:recognize) with diarization + word offsets.
//             Auth: GOOGLE_STT_ACCESS_TOKEN | GOOGLE_STT_CREDENTIALS_JSON (service account, JWT bearer) | GOOGLE_STT_API_KEY.
//  - whisper: any Whisper-compatible HTTP API (POST {WHISPER_API_URL}/audio/transcriptions, verbose_json);
//             a `speaker` field per segment (whisperX-style servers) is used for diarization when present.
// Endpoints are env-overridable so tests run against a local fake server.
import { createSign } from "node:crypto";
import { type Segment, durationToMs, groupWordsIntoSegments } from "@linkos/domain";
import { unavailable } from "./errors";

export interface SttResult {
  provider: string;
  language: string | null;
  segments: Segment[];
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<SttResult>;
}

const timeoutMs = () => Number(process.env.STT_TIMEOUT_MS ?? 120_000);
const languages = () => (process.env.STT_LANGUAGES ?? "ko-KR,en-US").split(",").map((s) => s.trim()).filter(Boolean);

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: invalid JSON`);
  }
}

// ---------------------------------------------------------------- Google v2
let googleToken: { token: string; exp: number } | null = null;

async function googleAuth(): Promise<{ headers: Record<string, string>; query: string }> {
  const env = process.env;
  if (env.GOOGLE_STT_ACCESS_TOKEN) return { headers: { authorization: `Bearer ${env.GOOGLE_STT_ACCESS_TOKEN}` }, query: "" };
  if (env.GOOGLE_STT_CREDENTIALS_JSON) {
    if (googleToken && googleToken.exp > Date.now() + 60_000) return { headers: { authorization: `Bearer ${googleToken.token}` }, query: "" };
    const sa = JSON.parse(env.GOOGLE_STT_CREDENTIALS_JSON) as { client_email: string; private_key: string; token_uri?: string };
    const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat: now, exp: now + 3600 })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await json(res, "google token");
    googleToken = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return { headers: { authorization: `Bearer ${googleToken.token}` }, query: "" };
  }
  if (env.GOOGLE_STT_API_KEY) return { headers: {}, query: `?key=${encodeURIComponent(env.GOOGLE_STT_API_KEY)}` };
  throw unavailable("stt_not_configured", "Google STT 인증 정보가 없습니다.");
}

export class GoogleSpeechV2 implements SttProvider {
  readonly name = "google-stt-v2";
  async transcribe(audio: Buffer): Promise<SttResult> {
    const env = process.env;
    const project = env.GOOGLE_STT_PROJECT;
    if (!project) throw unavailable("stt_not_configured", "GOOGLE_STT_PROJECT 가 설정되지 않았습니다.");
    const location = env.GOOGLE_STT_LOCATION ?? "global";
    const base = (env.GOOGLE_STT_ENDPOINT ?? `https://${location === "global" ? "" : `${location}-`}speech.googleapis.com`).replace(/\/$/, "");
    const recognizer = env.GOOGLE_STT_RECOGNIZER ?? "_";
    const auth = await googleAuth();
    const url = `${base}/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/recognizers/${encodeURIComponent(recognizer)}:recognize${auth.query}`;
    const maxSpeakers = Number(env.STT_MAX_SPEAKERS ?? 6);
    const body = {
      config: {
        autoDecodingConfig: {},
        languageCodes: languages(),
        model: env.GOOGLE_STT_MODEL ?? "long",
        features: {
          enableWordTimeOffsets: true,
          enableWordConfidence: true,
          enableAutomaticPunctuation: true,
          ...(env.STT_DIARIZATION === "0" ? {} : { diarizationConfig: { minSpeakerCount: 1, maxSpeakerCount: maxSpeakers } }),
        },
      },
      content: audio.toString("base64"),
    };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...auth.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs()) });
    const j = await json(res, "google stt");
    return parseGoogleV2(j);
  }
}

/** Google v2 RecognizeResponse → segments. Uses word-level speaker labels when present. */
export function parseGoogleV2(j: any): SttResult {
  const langs: string[] = [];
  const segments: Segment[] = [];
  let prevEnd = 0;
  for (const r of j?.results ?? []) {
    const alt = r?.alternatives?.[0];
    if (r?.languageCode) langs.push(r.languageCode);
    const endMs = durationToMs(r?.resultEndOffset);
    if (!alt?.transcript?.trim()) {
      prevEnd = endMs || prevEnd;
      continue;
    }
    const words = (alt.words ?? []).filter((w: any) => w?.word);
    if (words.length) {
      segments.push(
        ...groupWordsIntoSegments(
          words.map((w: any) => ({ word: String(w.word), startMs: durationToMs(w.startOffset), endMs: durationToMs(w.endOffset), speaker: w.speakerLabel ? `S${w.speakerLabel}` : null, confidence: typeof w.confidence === "number" ? w.confidence : null })),
        ),
      );
    } else {
      segments.push({ speaker: null, startMs: prevEnd, endMs: endMs || prevEnd, text: alt.transcript.trim(), confidence: typeof alt.confidence === "number" ? alt.confidence : null });
    }
    prevEnd = endMs || prevEnd;
  }
  const counts = new Map<string, number>();
  for (const l of langs) counts.set(l, (counts.get(l) ?? 0) + 1);
  const language = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { provider: "google-stt-v2", language, segments };
}

// ---------------------------------------------------------------- Whisper-compatible
export class WhisperCompatible implements SttProvider {
  readonly name = "whisper";
  async transcribe(audio: Buffer, mimeType: string): Promise<SttResult> {
    const env = process.env;
    const base = (env.WHISPER_API_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    if (!env.WHISPER_API_URL && !env.WHISPER_API_KEY) throw unavailable("stt_not_configured", "WHISPER_API_URL/WHISPER_API_KEY 가 설정되지 않았습니다.");
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") ? "mp3" : "webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${ext}`);
    form.append("model", env.WHISPER_MODEL ?? "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (env.STT_LANGUAGE) form.append("language", env.STT_LANGUAGE);
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: env.WHISPER_API_KEY ? { authorization: `Bearer ${env.WHISPER_API_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(timeoutMs()),
    });
    return parseWhisper(await json(res, "whisper"));
  }
}

export function parseWhisper(j: any): SttResult {
  const segs: Segment[] = (j?.segments ?? [])
    .filter((s: any) => typeof s?.text === "string" && s.text.trim())
    .map((s: any) => ({
      speaker: s.speaker != null ? String(s.speaker) : null,
      startMs: Math.round(Number(s.start ?? 0) * 1000),
      endMs: Math.round(Number(s.end ?? 0) * 1000),
      text: String(s.text).trim(),
      confidence: typeof s.avg_logprob === "number" ? Math.round(Math.exp(s.avg_logprob) * 1000) / 1000 : null,
    }));
  if (!segs.length && typeof j?.text === "string" && j.text.trim()) segs.push({ speaker: null, startMs: 0, endMs: Math.round(Number(j.duration ?? 0) * 1000), text: j.text.trim(), confidence: null });
  return { provider: "whisper", language: typeof j?.language === "string" ? j.language : null, segments: segs };
}

/** STT_PROVIDER=google|whisper; null when transcription is not configured (recordings are still stored). */
export function sttProvider(): SttProvider | null {
  switch ((process.env.STT_PROVIDER ?? "").toLowerCase()) {
    case "google":
      return new GoogleSpeechV2();
    case "whisper":
      return new WhisperCompatible();
    default:
      return null;
  }
}
