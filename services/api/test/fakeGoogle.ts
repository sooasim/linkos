// Minimal fake of the Google endpoints LINKOS uses (OAuth token, userinfo, People, Sheets, Gmail, Calendar, Drive).
// Behaves like the real APIs for the fields we send; records every call for assertions.
import { type Server, createServer } from "node:http";

const DEFAULT_SCOPE =
  "openid email profile https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

export interface FakeGoogle {
  url: string;
  calls: { method: string; path: string; body: any; auth: string | undefined; headers: Record<string, string | string[] | undefined>; raw: Buffer }[];
  people: Map<string, { etag: string; person: any }>;
  sheets: Map<string, { title: string; values: string[][] }>;
  gmailSent: { id: string; raw: string }[];
  gmailDrafts: Map<string, { raw: string }>;
  events: Map<string, { etag: string; body: any; sendUpdates: string | null }>;
  driveFiles: Map<string, { name: string; parents?: string[]; mimeType: string; size?: number; content?: Buffer; folder?: boolean }>;
  busy: { start: string; end: string }[];
  failNext: (status: number) => void;
  expireAccess: () => void;
  setGrantScope: (scope: string) => void;
  touchEvent: (id: string) => void;
  close: () => Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const calls: FakeGoogle["calls"] = [];
  const people = new Map<string, { etag: string; person: any }>();
  const sheets = new Map<string, { title: string; values: string[][] }>();
  const gmailSent: FakeGoogle["gmailSent"] = [];
  const gmailDrafts = new Map<string, { raw: string }>();
  const events = new Map<string, { etag: string; body: any; sendUpdates: string | null }>();
  const driveFiles: FakeGoogle["driveFiles"] = new Map();
  const busy: FakeGoogle["busy"] = [];
  let grantScope = DEFAULT_SCOPE;
  let failStatus: number | null = null;
  let validAccess = "access-1";
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBuf = Buffer.concat(chunks);
    const raw = rawBuf.toString();
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = (req.headers["content-type"] ?? "").includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : raw;
    }
    const url = new URL(req.url!, "http://x");
    calls.push({ method: req.method!, path: url.pathname + url.search, body, auth: req.headers.authorization, headers: req.headers, raw: rawBuf });
    const send = (status: number, obj?: unknown) => {
      if (obj === undefined) {
        res.writeHead(status);
        return res.end();
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (failStatus) {
      const s = failStatus;
      failStatus = null;
      return send(s, { error: { code: s, message: "injected failure" } });
    }
    const p = url.pathname;
    const m = req.method!;
    if (p === "/token") {
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token === "revoked") return send(400, { error: "invalid_grant" });
        validAccess = `access-${++n + 1}`;
        return send(200, { access_token: validAccess, expires_in: 3600, scope: "openid email" });
      }
      return send(200, { access_token: validAccess, refresh_token: "refresh-1", expires_in: 3600, scope: grantScope });
    }
    const authed = req.headers.authorization === `Bearer ${validAccess}`;
    if (!authed) return send(401, { error: { code: 401, message: "invalid token" } });
    if (p === "/userinfo") return send(200, { sub: "g-123", email: "fake@gmail.com", email_verified: true, name: "Fake User" });
    // ---- People
    if (p === "/people/people:createContact") {
      const id = `people/c${++n}`;
      people.set(id, { etag: `e${n}`, person: body });
      return send(200, { resourceName: id, etag: `e${n}` });
    }
    const upd = p.match(/^\/people\/(people\/c\d+):updateContact$/);
    if (upd) {
      const cur = people.get(upd[1]!);
      if (!cur) return send(404, {});
      if (body.etag !== cur.etag) return send(400, { error: { code: 400, message: "Request person.etag is different than the current person.etag. Clear local cache and get the latest person.", status: "FAILED_PRECONDITION" } });
      const etag = `e${++n}`;
      people.set(upd[1]!, { etag, person: body });
      return send(200, { resourceName: upd[1], etag });
    }
    const getPerson = p.match(/^\/people\/(people\/c\d+)$/);
    if (getPerson && m === "GET") {
      const cur = people.get(getPerson[1]!);
      return cur ? send(200, { resourceName: getPerson[1], etag: cur.etag }) : send(404, {});
    }
    // ---- Sheets
    if (p === "/sheets/spreadsheets" && m === "POST") {
      const id = `sheet${++n}`;
      sheets.set(id, { title: body.properties.title, values: [] });
      return send(200, { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}` });
    }
    const vals = p.match(/^\/sheets\/spreadsheets\/([^/]+)\/values\//);
    if (vals && m === "PUT") {
      const s = sheets.get(decodeURIComponent(vals[1]!));
      if (!s) return send(404, {});
      if (url.searchParams.get("valueInputOption") !== "RAW") return send(400, { error: "expected RAW" });
      s.values = body.values;
      return send(200, { updatedRows: body.values.length });
    }
    // ---- Gmail
    if (p === "/gmail/users/me/messages/send" && m === "POST") {
      if (!body?.raw || /[+/=]/.test(body.raw)) return send(400, { error: { message: "raw must be base64url" } });
      const id = `msg${++n}`;
      gmailSent.push({ id, raw: Buffer.from(body.raw, "base64url").toString("utf8") });
      return send(200, { id, threadId: `t${n}`, labelIds: ["SENT"] });
    }
    if (p === "/gmail/users/me/drafts" && m === "POST") {
      const id = `r-${++n}`;
      gmailDrafts.set(id, { raw: Buffer.from(body.message.raw, "base64url").toString("utf8") });
      return send(200, { id, message: { id: `m${n}`, labelIds: ["DRAFT"] } });
    }
    const draft = p.match(/^\/gmail\/users\/me\/drafts\/([^/]+)$/);
    if (draft) {
      const id = decodeURIComponent(draft[1]!);
      if (!gmailDrafts.has(id)) return send(404, { error: { message: "not found" } });
      if (m === "DELETE") {
        gmailDrafts.delete(id);
        return send(204);
      }
      if (m === "PUT") {
        gmailDrafts.set(id, { raw: Buffer.from(body.message.raw, "base64url").toString("utf8") });
        return send(200, { id, message: { id: `m${++n}` } });
      }
    }
    // ---- Calendar
    if (p === "/calendar/freeBusy" && m === "POST") return send(200, { kind: "calendar#freeBusy", timeMin: body.timeMin, timeMax: body.timeMax, calendars: { primary: { busy } } });
    if (p === "/calendar/calendars/primary/events" && m === "POST") {
      const id = body.id ?? `ev${++n}`;
      if (events.has(id)) return send(409, { error: { code: 409, message: "The requested identifier already exists." } });
      const etag = `"${++n}"`;
      events.set(id, { etag, body, sendUpdates: url.searchParams.get("sendUpdates") });
      return send(200, { id, etag, htmlLink: `https://calendar.google.com/event?eid=${id}`, status: "confirmed" });
    }
    const ev = p.match(/^\/calendar\/calendars\/primary\/events\/([^/]+)$/);
    if (ev) {
      const id = decodeURIComponent(ev[1]!);
      const cur = events.get(id);
      if (!cur) return send(404, { error: { code: 404 } });
      if (m === "GET") return send(200, { id, etag: cur.etag, htmlLink: `https://calendar.google.com/event?eid=${id}` });
      if (m === "DELETE") {
        events.delete(id);
        return send(204);
      }
      if (m === "PATCH") {
        const ifMatch = req.headers["if-match"];
        if (ifMatch && ifMatch !== cur.etag) return send(412, { error: { code: 412, message: "Precondition Failed" } });
        const etag = `"${++n}"`;
        events.set(id, { etag, body: { ...cur.body, ...body }, sendUpdates: url.searchParams.get("sendUpdates") });
        return send(200, { id, etag, htmlLink: `https://calendar.google.com/event?eid=${id}` });
      }
    }
    // ---- Drive
    if (p === "/drive/files" && m === "POST") {
      const id = `folder${++n}`;
      driveFiles.set(id, { name: body.name, mimeType: body.mimeType, folder: true });
      return send(200, { id });
    }
    const df = p.match(/^\/drive\/files\/([^/]+)$/);
    if (df && m === "GET") {
      const f = driveFiles.get(decodeURIComponent(df[1]!));
      return f ? send(200, { id: df[1], trashed: false }) : send(404, {});
    }
    if (p === "/driveUpload/files" && m === "POST") {
      if (url.searchParams.get("uploadType") !== "multipart") return send(400, {});
      const boundary = String(req.headers["content-type"]).match(/boundary=(.+)$/)?.[1];
      if (!boundary) return send(400, { error: "no boundary" });
      const text = rawBuf.toString("latin1");
      const parts = text.split(`--${boundary}`).slice(1, -1);
      const meta = JSON.parse(Buffer.from(parts[0]!.split("\r\n\r\n")[1]!.replace(/\r\n$/, ""), "latin1").toString("utf8"));
      const content = Buffer.from(parts[1]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""), "latin1");
      if (meta.parents?.some((x: string) => !driveFiles.get(x)?.folder)) return send(404, { error: "parent not found" });
      const id = `file${++n}`;
      driveFiles.set(id, { name: meta.name, parents: meta.parents, mimeType: meta.mimeType, size: content.length, content });
      return send(200, { id, name: meta.name, webViewLink: `https://drive.google.com/file/d/${id}/view` });
    }
    send(404, { error: "not found", path: p });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    people,
    sheets,
    gmailSent,
    gmailDrafts,
    events,
    driveFiles,
    busy,
    failNext: (s) => (failStatus = s),
    expireAccess: () => (validAccess = "rotated-elsewhere"),
    setGrantScope: (s) => (grantScope = s),
    touchEvent: (id) => {
      const e = events.get(id);
      if (e) e.etag = `"${++n}"`;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
