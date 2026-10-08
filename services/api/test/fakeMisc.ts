// Small local fakes: SMTP server, Web Push service (HTTPS, self-signed), webhook receiver, Anthropic Messages API.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type Server as NetServer, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- SMTP (no TLS, no AUTH: enough for nodemailer's plain SMTP path) ----------
export interface FakeSmtp {
  url: string;
  messages: { from: string; to: string[]; data: string }[];
  close: () => Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtp["messages"] = [];
  const server: NetServer = createNetServer((sock) => {
    let buf = "";
    let inData = false;
    let cur = { from: "", to: [] as string[], data: "" };
    sock.write("220 fake.smtp ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push(cur);
          cur = { from: "", to: [], data: "" };
          sock.write("250 2.0.0 queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-fake.smtp\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL") {
          cur.from = line.match(/<([^>]*)>/)?.[1] ?? "";
          sock.write("250 2.1.0 OK\r\n");
        } else if (cmd === "RCPT") {
          cur.to.push(line.match(/<([^>]*)>/)?.[1] ?? "");
          sock.write("250 2.1.5 OK\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd === "QUIT") {
          sock.end("221 2.0.0 Bye\r\n");
          return;
        } else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `smtp://127.0.0.1:${port}`, messages, close: () => new Promise((r) => server.close(() => r())) };
}

// ---------- Web Push service (web-push always speaks HTTPS) ----------
export interface FakePush {
  url: string;
  ca: string;
  received: { path: string; headers: Record<string, string | string[] | undefined>; bytes: number }[];
  close: () => Promise<void>;
}

export async function startFakePush(): Promise<FakePush> {
  const dir = mkdtempSync(join(tmpdir(), "linkos-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  const received: FakePush["received"] = [];
  const server = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert }, async (req, res) => {
    let bytes = 0;
    for await (const c of req) bytes += (c as Buffer).length;
    received.push({ path: req.url!, headers: req.headers, bytes });
    if (req.url!.startsWith("/gone")) {
      res.writeHead(410);
      return res.end();
    }
    res.writeHead(201, { location: `/msg/${received.length}` });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, ca: cert, received, close: () => new Promise((r) => server.close(() => r())) };
}

// ---------- webhook receiver ----------
export interface FakeReceiver {
  url: string;
  received: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  statuses: number[];
  close: () => Promise<void>;
}

export async function startReceiver(): Promise<FakeReceiver> {
  const received: FakeReceiver["received"] = [];
  const statuses: number[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(statuses.shift() ?? 200);
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, received, statuses, close: () => new Promise((r) => server.close(() => r())) };
}

// ---------- Anthropic Messages API (only the translation task answers; everything else is a 400 → caller's rule fallback) ----------
export interface FakeAnthropic {
  url: string;
  requests: any[];
  close: () => Promise<void>;
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: any[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(body);
    const content = String(body.messages?.[0]?.content ?? "");
    const data = content.match(/<data>\n([\s\S]*)\n<\/data>/)?.[1] ?? "";
    if (!content.startsWith("Translate") || data.includes("번역불가")) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake: unsupported task" } }));
    }
    const items = (JSON.parse(data) as { key: string; text: string }[]).map((i) => ({ key: i.key, text: `[EN] ${i.text}` }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: JSON.stringify({ items }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
