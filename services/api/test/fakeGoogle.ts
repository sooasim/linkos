// Minimal fake of the Google endpoints LINKOS uses (OAuth token, userinfo, People API, Sheets API).
// Behaves like the real APIs for the fields we send; records every call for assertions.
import { type Server, createServer } from "node:http";

export interface FakeGoogle {
  url: string;
  calls: { method: string; path: string; body: any; auth: string | undefined }[];
  people: Map<string, { etag: string; person: any }>;
  sheets: Map<string, { title: string; values: string[][] }>;
  failNext: (status: number) => void;
  expireAccess: () => void;
  close: () => Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const calls: FakeGoogle["calls"] = [];
  const people = new Map<string, { etag: string; person: any }>();
  const sheets = new Map<string, { title: string; values: string[][] }>();
  let failStatus: number | null = null;
  let validAccess = "access-1";
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const url = new URL(req.url!, "http://x");
    calls.push({ method: req.method!, path: url.pathname + url.search, body, auth: req.headers.authorization });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (failStatus) {
      const s = failStatus;
      failStatus = null;
      return send(s, { error: { code: s, message: "injected failure" } });
    }
    const p = url.pathname;
    if (p === "/token") {
      if (body.grant_type === "refresh_token") {
        validAccess = `access-${++n + 1}`;
        return send(200, { access_token: validAccess, expires_in: 3600, scope: "openid email" });
      }
      return send(200, { access_token: validAccess, refresh_token: "refresh-1", expires_in: 3600, scope: "openid email profile https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/drive.file" });
    }
    const authed = req.headers.authorization === `Bearer ${validAccess}`;
    if (!authed) return send(401, { error: { code: 401, message: "invalid token" } });
    if (p === "/userinfo") return send(200, { sub: "g-123", email: "fake@gmail.com", email_verified: true, name: "Fake User" });
    if (p === "/people/people:createContact") {
      const id = `people/c${++n}`;
      people.set(id, { etag: `e${n}`, person: body });
      return send(200, { resourceName: id, etag: `e${n}` });
    }
    const upd = p.match(/^\/people\/(people\/c\d+):updateContact$/);
    if (upd) {
      const cur = people.get(upd[1]!);
      if (!cur) return send(404, {});
      if (body.etag !== cur.etag) return send(400, { error: { code: 400, message: "etag mismatch" } });
      const etag = `e${++n}`;
      people.set(upd[1]!, { etag, person: body });
      return send(200, { resourceName: upd[1], etag });
    }
    if (p === "/sheets/spreadsheets" && req.method === "POST") {
      const id = `sheet${++n}`;
      sheets.set(id, { title: body.properties.title, values: [] });
      return send(200, { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}` });
    }
    const vals = p.match(/^\/sheets\/spreadsheets\/([^/]+)\/values\//);
    if (vals && req.method === "PUT") {
      const s = sheets.get(decodeURIComponent(vals[1]!));
      if (!s) return send(404, {});
      if (url.searchParams.get("valueInputOption") !== "RAW") return send(400, { error: "expected RAW" });
      s.values = body.values;
      return send(200, { updatedRows: body.values.length });
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
    failNext: (s) => (failStatus = s),
    expireAccess: () => (validAccess = "rotated-elsewhere"),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
