// Local fakes for track C integration tests: S3-compatible object store, clamd (INSTREAM), STT providers.
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from "node:net";

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

export interface Fake {
  url: string;
  close(): Promise<void>;
}

/** Path-style S3: PUT/GET/DELETE /{bucket}/{key}. Does not verify SigV4 but records that requests were signed. */
export async function startFakeS3(): Promise<Fake & { objects: Map<string, Buffer>; signed: number }> {
  const objects = new Map<string, Buffer>();
  const state = { signed: 0 };
  const server: Server = createHttpServer(async (req, res) => {
    const key = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
    if (String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256")) state.signed++;
    if (req.method === "PUT") {
      objects.set(key, await readBody(req));
      res.writeHead(200, { etag: '"fake"' }).end();
    } else if (req.method === "GET") {
      const o = objects.get(key);
      if (!o) {
        res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(o.length) }).end(o);
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    get signed() {
      return state.signed;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** clamd INSTREAM: "stream: OK" or "stream: Eicar-Test-Signature FOUND" when the payload contains "EVIL-PAYLOAD". */
export async function startFakeClamd(): Promise<{ host: string; port: number; scans: number; close(): Promise<void> }> {
  const state = { scans: 0 };
  const server: TcpServer = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let headerDone = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerDone) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        if (buf.subarray(0, z).toString() !== "zINSTREAM") {
          sock.end("UNKNOWN COMMAND\0");
          return;
        }
        buf = buf.subarray(z + 1);
        headerDone = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          state.scans++;
          sock.end(payload.includes("EVIL-PAYLOAD") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < 4 + len) return;
        payload = Buffer.concat([payload, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    get scans() {
      return state.scans;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Fake STT: Google Speech v2 `:recognize` (+ OAuth token endpoint for service-account JWT) and a
 * Whisper-compatible `/v1/audio/transcriptions`. The audio part's 5th byte selects a script.
 */
export async function startFakeStt(): Promise<Fake & { calls: { google: number; whisper: number; token: number }; lastAuth: string | null; lastGoogleBody: any }> {
  const calls = { google: 0, whisper: 0, token: 0 };
  const state: { lastAuth: string | null; lastGoogleBody: any } = { lastAuth: null, lastGoogleBody: null };
  const scripts: Record<number, { speaker: string; words: [string, number, number][] }[]> = {
    0: [
      { speaker: "1", words: [["오늘", 0, 0.4], ["회의", 0.45, 0.8], ["감사합니다.", 0.85, 1.4], ["3개", 1.5, 1.8], ["병원", 1.85, 2.2], ["파일럿으로", 2.25, 2.9], ["진행하기로", 2.95, 3.5], ["했습니다.", 3.55, 4.0]] },
      { speaker: "2", words: [["제가", 4.6, 4.9], ["제안서를", 4.95, 5.5], ["금요일까지", 5.55, 6.2], ["보내드리겠습니다.", 6.25, 7.2]] },
    ],
    1: [{ speaker: "1", words: [["다음", 0.2, 0.5], ["주", 0.55, 0.7], ["화요일에", 0.75, 1.3], ["다시", 1.35, 1.6], ["뵙겠습니다.", 1.65, 2.3]] }],
  };
  const server: Server = createHttpServer(async (req, res) => {
    const url = req.url ?? "";
    const body = await readBody(req);
    if (url.startsWith("/token")) {
      calls.token++;
      const p = new URLSearchParams(body.toString());
      if (p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || (p.get("assertion") ?? "").split(".").length !== 3) {
        res.writeHead(400).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fake-sa-token", expires_in: 3600 }));
      return;
    }
    if (/\/v2\/projects\/[^/]+\/locations\/[^/]+\/recognizers\/[^/]+:recognize/.test(url)) {
      calls.google++;
      state.lastAuth = String(req.headers.authorization ?? "");
      const j = JSON.parse(body.toString());
      state.lastGoogleBody = { ...j, content: undefined };
      const audio = Buffer.from(j.content, "base64");
      const script = scripts[audio[4] ?? 0] ?? scripts[0]!;
      const results = script.map((turn) => ({
        alternatives: [{
          transcript: turn.words.map((w) => w[0]).join(" "),
          confidence: 0.9,
          words: turn.words.map(([word, s, e]) => ({ word, startOffset: `${s}s`, endOffset: `${e}s`, confidence: 0.9, speakerLabel: turn.speaker })),
        }],
        resultEndOffset: `${turn.words[turn.words.length - 1]![2]}s`,
        languageCode: "ko-kr",
      }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }));
      return;
    }
    if (url.startsWith("/v1/audio/transcriptions")) {
      calls.whisper++;
      state.lastAuth = String(req.headers.authorization ?? "");
      const ok = body.includes("verbose_json") && body.includes('name="file"');
      if (!ok) {
        res.writeHead(400).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          language: "korean",
          duration: 6,
          text: "결정: 2차 미팅 진행. 견적서는 내일까지 보내드리겠습니다.",
          segments: [
            { start: 0, end: 2.5, text: "결정: 2차 미팅 진행.", avg_logprob: -0.1, speaker: "SPEAKER_00" },
            { start: 2.6, end: 6, text: "견적서는 내일까지 보내드리겠습니다.", avg_logprob: -0.2, speaker: "SPEAKER_01" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    get lastAuth() {
      return state.lastAuth;
    },
    get lastGoogleBody() {
      return state.lastGoogleBody;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
