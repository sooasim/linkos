// Local fakes for Microsoft identity + Graph, Salesforce REST, HubSpot CRM v3 and Dynamics 365 Web API.
// Only the request/response shapes LINKOS uses are modeled, including the concurrency controls
// (Graph/Dynamics If-Match → 412, Salesforce If-Unmodified-Since → 412, HubSpot updatedAt) and duplicate rules.
import { type Server, createServer } from "node:http";

type Rec = Record<string, any>;

export interface FakeCrm {
  url: string;
  calls: { method: string; path: string; body: any; headers: Record<string, string | string[] | undefined> }[];
  ms: { contacts: Map<string, Rec>; events: Map<string, Rec>; mail: Rec[]; busy: { start: string; end: string }[] };
  sf: { records: Map<string, Rec>; expireAccess: () => void; touch: (id: string) => void };
  hs: {
    contacts: Map<string, Rec>;
    notes: Map<string, Rec>;
    /** F-121 Company/Deal sync */
    companies: Map<string, Rec>;
    deals: Map<string, Rec>;
    /** v4 default associations: "contacts:501->companies:502" */
    associations: Set<string>;
    touch: (id: string) => void;
    /** a HubSpot user edits a company/deal → updatedAt moves */
    touchAny: (id: string, props?: Record<string, string>) => void;
    /** seed a pre-existing HubSpot company (dedupe tests) */
    seedCompany: (props: Record<string, string>) => Rec;
  };
  dyn: { records: Map<string, Rec>; touch: (id: string) => void };
  close: () => Promise<void>;
}

export async function startFakeCrm(): Promise<FakeCrm> {
  const calls: FakeCrm["calls"] = [];
  const msContacts = new Map<string, Rec>();
  const msEvents = new Map<string, Rec>();
  const msMail: Rec[] = [];
  const msBusy: { start: string; end: string }[] = [];
  const sfRecords = new Map<string, Rec>();
  const hsContacts = new Map<string, Rec>();
  const hsNotes = new Map<string, Rec>();
  const hsCompanies = new Map<string, Rec>();
  const hsDeals = new Map<string, Rec>();
  const hsAssoc = new Set<string>();
  const hsStores: Record<string, Map<string, Rec>> = { contacts: hsContacts, notes: hsNotes, companies: hsCompanies, deals: hsDeals };
  const dynRecords = new Map<string, Rec>();
  let n = 0;
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const tokens: Record<string, string> = { ms: "ms-access-1", sf: "sf-access-1", hs: "hs-access-1" };
  let base = "";

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const url = new URL(req.url!, "http://x");
    const p = decodeURIComponent(url.pathname);
    const m = req.method!;
    calls.push({ method: m, path: p + url.search, body, headers: req.headers });
    const send = (status: number, obj?: unknown, headers: Record<string, string> = {}) => {
      if (obj === undefined) {
        res.writeHead(status, headers);
        return res.end();
      }
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const bearer = (k: string) => req.headers.authorization === `Bearer ${tokens[k]}`;

    // ---------- Microsoft identity (also used by Dynamics) ----------
    if (p === "/ms/token") {
      if (body.grant_type === "refresh_token") tokens.ms = `ms-access-${++n}`;
      return send(200, { token_type: "Bearer", access_token: tokens.ms, refresh_token: "ms-refresh", expires_in: 3600, scope: body.scope ?? "" });
    }
    // ---------- Graph ----------
    if (p.startsWith("/graph/v1.0/")) {
      if (!bearer("ms")) return send(401, { error: { code: "InvalidAuthenticationToken" } });
      const g = p.slice("/graph/v1.0".length);
      if (g === "/me" && m === "GET") return send(200, { id: "ms-user-1", mail: "owner@contoso.com", userPrincipalName: "owner@contoso.com" });
      if (g === "/me/contacts" && m === "POST") {
        const id = `AAMk-c${++n}`;
        const rec = { ...body, id, "@odata.etag": `W/"${++n}"` };
        msContacts.set(id, rec);
        return send(201, rec);
      }
      const mc = g.match(/^\/me\/contacts\/(.+)$/);
      if (mc) {
        const cur = msContacts.get(mc[1]!);
        if (!cur) return send(404, { error: { code: "ErrorItemNotFound" } });
        if (m === "GET") return send(200, cur);
        if (m === "PATCH") {
          if (req.headers["if-match"] && req.headers["if-match"] !== cur["@odata.etag"]) return send(412, { error: { code: "ErrorIrresolvableConflict" } });
          const rec = { ...cur, ...body, "@odata.etag": `W/"${++n}"` };
          msContacts.set(cur.id, rec);
          return send(200, rec);
        }
      }
      if (g === "/me/events" && m === "POST") {
        const dup = [...msEvents.values()].find((e) => e.transactionId && e.transactionId === body.transactionId);
        if (dup) return send(201, dup);
        const id = `AAMk-e${++n}`;
        const rec = { ...body, id, "@odata.etag": `W/"${++n}"`, webLink: `https://outlook.office365.com/owa/?itemid=${id}` };
        msEvents.set(id, rec);
        return send(201, rec);
      }
      const me = g.match(/^\/me\/events\/(.+)$/);
      if (me) {
        const cur = msEvents.get(me[1]!);
        if (!cur) return send(404, {});
        if (m === "DELETE") {
          msEvents.delete(cur.id);
          return send(204);
        }
        if (m === "PATCH") {
          if (req.headers["if-match"] && req.headers["if-match"] !== cur["@odata.etag"]) return send(412, { error: { code: "ErrorIrresolvableConflict" } });
          const rec = { ...cur, ...body, "@odata.etag": `W/"${++n}"` };
          msEvents.set(cur.id, rec);
          return send(200, rec);
        }
      }
      if (g === "/me/calendar/getSchedule" && m === "POST") {
        return send(200, { value: [{ scheduleId: body.schedules[0], scheduleItems: msBusy.map((b) => ({ status: "busy", start: { dateTime: b.start.replace("Z", ""), timeZone: "UTC" }, end: { dateTime: b.end.replace("Z", ""), timeZone: "UTC" } })) }] });
      }
      if (g === "/me/sendMail" && m === "POST") {
        if (!body?.message?.toRecipients?.length) return send(400, { error: { code: "ErrorInvalidRecipients" } });
        msMail.push(body);
        return send(202, undefined, { "request-id": `req-${++n}` });
      }
      return send(404, { error: { code: "NotFound", path: g } });
    }
    // ---------- Salesforce ----------
    if (p === "/sf/services/oauth2/token") {
      if (body.grant_type === "refresh_token") {
        tokens.sf = `sf-access-${++n}`;
        return send(200, { access_token: tokens.sf, instance_url: `${base}/sf`, token_type: "Bearer" });
      }
      return send(200, { access_token: tokens.sf, refresh_token: "sf-refresh", instance_url: `${base}/sf`, id: `${base}/sf/id/00Dx/005x`, token_type: "Bearer", scope: "api refresh_token" });
    }
    if (p.startsWith("/sf/services/data/v61.0/sobjects/")) {
      if (!bearer("sf")) return send(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]);
      const parts = p.slice("/sf/services/data/v61.0/sobjects/".length).split("/");
      const [type, a, b] = parts as [string, string | undefined, string | undefined];
      if (!a && m === "POST") {
        if ((type === "Contact" || type === "Lead") && !body.LastName) return send(400, [{ errorCode: "REQUIRED_FIELD_MISSING", fields: ["LastName"] }]);
        if (type === "Lead" && !body.Company) return send(400, [{ errorCode: "REQUIRED_FIELD_MISSING", fields: ["Company"] }]);
        if (body.Email === "dup@sf.test") return send(400, [{ errorCode: "DUPLICATES_DETECTED", message: "Use one of these records?", duplicateResult: { matchResults: [{ matchRecords: [{ record: { Id: "003EXISTING" } }] }] } }]);
        const id = `${type === "Task" ? "00T" : type === "Lead" ? "00Q" : "003"}${String(++n).padStart(6, "0")}`;
        sfRecords.set(id, { ...body, Id: id, type, LastModifiedDate: tick() });
        return send(201, { id, success: true, errors: [] });
      }
      if (a && b && m === "PATCH") {
        // upsert by external id field
        const existing = [...sfRecords.values()].find((r) => r.type === type && r[a] === b);
        if (existing) {
          Object.assign(existing, body, { LastModifiedDate: tick() });
          return send(200, { id: existing.Id, success: true, errors: [], created: false });
        }
        const id = `003${String(++n).padStart(6, "0")}`;
        sfRecords.set(id, { ...body, [a]: b, Id: id, type, LastModifiedDate: tick() });
        return send(201, { id, success: true, errors: [], created: true });
      }
      if (a && b && m === "GET") {
        const rec = [...sfRecords.values()].find((r) => r.type === type && r[a] === b);
        return rec ? send(200, { Id: rec.Id }) : send(404, [{ errorCode: "NOT_FOUND" }]);
      }
      if (a) {
        const rec = sfRecords.get(a);
        if (!rec) return send(404, [{ errorCode: "NOT_FOUND" }]);
        if (m === "GET") return send(200, { Id: rec.Id, LastModifiedDate: rec.LastModifiedDate });
        if (m === "PATCH") {
          const ius = req.headers["if-unmodified-since"];
          if (ius && Date.parse(rec.LastModifiedDate) > Date.parse(String(ius)) + 999) return send(412, [{ errorCode: "PRECONDITION_FAILED" }]);
          Object.assign(rec, body, { LastModifiedDate: tick() });
          return send(204);
        }
      }
      return send(404, [{ errorCode: "NOT_FOUND" }]);
    }
    // ---------- HubSpot ----------
    if (p === "/hs/oauth/v1/token") {
      if (body.grant_type === "refresh_token") tokens.hs = `hs-access-${++n}`;
      return send(200, { access_token: tokens.hs, refresh_token: "hs-refresh", expires_in: 1800, token_type: "bearer" });
    }
    if (p.startsWith("/hs/oauth/v1/access-tokens/")) return send(200, { hub_id: 4242, user: "owner@hub.test", scopes: ["oauth"] });
    if (p.startsWith("/hs/crm/v4/objects/")) {
      // PUT /crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}
      if (!bearer("hs")) return send(401, { status: "error", category: "INVALID_AUTHENTICATION" });
      const [, , , , , from, fromId, kw, def, to, toId] = p.split("/");
      if (m !== "PUT" || kw !== "associations" || def !== "default") return send(404, { status: "error" });
      if (!hsStores[from!]?.get(fromId!) || !hsStores[to!]?.get(toId!)) return send(404, { status: "error", category: "OBJECT_NOT_FOUND" });
      hsAssoc.add(`${from}:${fromId}->${to}:${toId}`);
      return send(200, { status: "COMPLETE", results: [{ from: { id: fromId }, to: { id: toId } }] });
    }
    if (p.startsWith("/hs/crm/v3/objects/")) {
      if (!bearer("hs")) return send(401, { status: "error", category: "INVALID_AUTHENTICATION" });
      const [, , , , , obj, id] = p.split("/");
      const store = hsStores[obj!];
      if (!store) return send(404, { status: "error", category: "OBJECT_NOT_FOUND" });
      if (id === "search" && m === "POST") {
        const f = body?.filterGroups?.[0]?.filters?.[0] as { propertyName: string; operator: string; value: string } | undefined;
        const results = [...store.values()].filter((r) => f && f.operator === "EQ" && String(r.properties[f.propertyName] ?? "").toLowerCase() === String(f.value).toLowerCase());
        return send(200, { total: results.length, results: results.slice(0, body?.limit ?? 10).map((r) => ({ id: r.id, properties: r.properties, updatedAt: r.updatedAt })) });
      }
      if (obj === "deals" && m === "POST" && !id) {
        if (!body?.properties?.dealname || !body?.properties?.pipeline || !body?.properties?.dealstage) return send(400, { status: "error", category: "VALIDATION_ERROR", message: "dealname/pipeline/dealstage required" });
        for (const a of body.associations ?? []) {
          const typeId = a.types?.[0]?.associationTypeId;
          const target = typeId === 3 ? hsContacts : typeId === 5 || typeId === 341 ? hsCompanies : null;
          if (!target?.get(a.to?.id)) return send(400, { status: "error", category: "VALIDATION_ERROR", message: `bad association ${typeId}:${a.to?.id}` });
        }
      }
      if (!id && m === "POST") {
        if (obj === "contacts") {
          const dup = [...hsContacts.values()].find((c) => c.properties.email && c.properties.email === body.properties.email);
          if (dup) return send(409, { status: "error", message: `Contact already exists. Existing ID: ${dup.id}`, category: "CONFLICT" });
        }
        const rec = { id: String(500 + ++n), properties: body.properties, associations: body.associations, updatedAt: tick() };
        store.set(rec.id, rec);
        return send(201, rec);
      }
      const cur = id ? store.get(id) : undefined;
      if (!cur) return send(404, { status: "error", category: "OBJECT_NOT_FOUND" });
      if (m === "GET") return send(200, { id: cur.id, properties: cur.properties, updatedAt: cur.updatedAt });
      if (m === "PATCH") {
        cur.properties = { ...cur.properties, ...body.properties };
        cur.updatedAt = tick();
        return send(200, { id: cur.id, properties: cur.properties, updatedAt: cur.updatedAt });
      }
    }
    // ---------- Dynamics ----------
    if (p.startsWith("/dyn/api/data/v9.2/")) {
      if (!bearer("ms")) return send(401, { error: { code: "0x80040220" } });
      const d = p.slice("/dyn/api/data/v9.2/".length);
      if (d === "WhoAmI") return send(200, { UserId: "dyn-user-1", BusinessUnitId: "bu", OrganizationId: "org" });
      const create = d.match(/^(contacts|leads|annotations)$/);
      if (create && m === "POST") {
        if (req.headers["mscrm.suppressduplicatedetection"] === "false" && body.emailaddress1 === "dup@dyn.test") return send(412, { error: { code: "0x80040333", message: "A record was not created or updated because a duplicate of the current record already exists." } });
        const set = create[1]!;
        const key = set === "contacts" ? "contactid" : set === "leads" ? "leadid" : "annotationid";
        const id = `0000000${++n}-0000-0000-0000-000000000000`.slice(-36);
        const rec = { ...body, [key]: id, "@odata.etag": `W/"${++n}"`, set };
        dynRecords.set(id, rec);
        return send(201, rec);
      }
      const upd = d.match(/^(contacts|leads|annotations)\((.+)\)$/);
      if (upd && m === "PATCH") {
        const cur = dynRecords.get(upd[2]!);
        if (!cur) return send(404, { error: { code: "0x80040217" } });
        const im = req.headers["if-match"];
        if (im && im !== "*" && im !== cur["@odata.etag"]) return send(412, { error: { code: "0x80060882", message: "The version of the existing record doesn't match" } });
        Object.assign(cur, body, { "@odata.etag": `W/"${++n}"` });
        return send(200, cur);
      }
      return send(404, { error: { code: "0x80060888" } });
    }
    send(404, { error: "not found", path: p });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  return {
    url: base,
    calls,
    ms: { contacts: msContacts, events: msEvents, mail: msMail, busy: msBusy },
    sf: {
      records: sfRecords,
      expireAccess: () => (tokens.sf = "sf-rotated"),
      touch: (id) => {
        const r = sfRecords.get(id);
        if (r) r.LastModifiedDate = new Date((clock += 60_000)).toISOString();
      },
    },
    hs: {
      contacts: hsContacts,
      notes: hsNotes,
      companies: hsCompanies,
      deals: hsDeals,
      associations: hsAssoc,
      touch: (id) => {
        const r = hsContacts.get(id);
        if (r) r.updatedAt = tick();
      },
      touchAny: (id, props) => {
        const r = hsCompanies.get(id) ?? hsDeals.get(id) ?? hsContacts.get(id);
        if (!r) return;
        if (props) Object.assign(r.properties, props);
        r.updatedAt = tick();
      },
      seedCompany: (props) => {
        const rec = { id: String(500 + ++n), properties: { ...props }, updatedAt: tick() };
        hsCompanies.set(rec.id, rec);
        return rec;
      },
    },
    dyn: {
      records: dynRecords,
      touch: (id) => {
        const r = dynRecords.get(id);
        if (r) r["@odata.etag"] = `W/"${++n}"`;
      },
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
