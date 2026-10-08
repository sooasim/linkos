#!/usr/bin/env node
// F-185 performance budget / load simulation against a running server.
// Seeds a heavy account (5,000 contacts with encounters/notes, 300 connected LINKOS users with Offer/Need),
// then fires concurrent requests and checks p95 against the whitepaper SLOs (백서 20).
// Usage: DATABASE_URL=... BASE=http://localhost:3100 node scripts/loadtest.mjs [--contacts 5000] [--concurrency 20]
import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3100";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N_CONTACTS = arg("contacts", 5000);
const N_PEERS = arg("peers", 300);
const CONC = arg("concurrency", 20);
const REQS = arg("requests", 200);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const SLO = {
  "POST /exchange/sessions": 300,
  "GET guest landing (API)": 300,
  "GET /contacts?q=": 400,
  "GET /contacts (list)": 400,
  "POST /ai/search": 1500,
  "GET /matches": 1500,
  "GET /app (home SSR)": 1000,
  "GET /x/{token} (guest SSR)": 800,
};

async function signup() {
  const email = `load${Date.now()}${Math.random().toString(36).slice(2, 6)}@load.test`;
  const otp = await (await fetch(`${BASE}/api/v1/auth/otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) })).json();
  const r = await fetch(`${BASE}/api/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code: otp.devCode, consents: ["terms", "privacy", "age_14"].map((type) => ({ type, granted: true })) }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = await (await fetch(`${BASE}/api/v1/me`, { headers: { cookie } })).json();
  return { cookie, id: me.user.id };
}

const words = ["의료", "AI", "로봇", "물류", "핀테크", "교육", "에너지", "바이오", "SaaS", "커머스", "보안", "모빌리티"];
const places = ["코엑스", "판교 테크노밸리", "킨텍스", "부산 벡스코", "성수 밋업", "강남 데모데이"];
const pick = (a, i) => a[i % a.length];

async function seed(userId) {
  const t0 = Date.now();
  await db.query(
    `WITH co AS (
       INSERT INTO companies (name, normalized_name)
       SELECT '부하회사' || g || ' ' || $3::text, 'loadco' || g || '-' || $2::text FROM generate_series(1, 400) g
       ON CONFLICT (normalized_name) DO UPDATE SET name = companies.name RETURNING id
     ), cs AS (
       SELECT id, row_number() OVER () AS rn FROM co
     ), ins AS (
       INSERT INTO contacts (owner_user_id, company_id, full_name, job_title, email, phone, source)
       SELECT $1::uuid, (SELECT id FROM cs WHERE rn = 1 + (g % 400)), '사람' || g, (ARRAY['대표','이사','팀장','매니저','CTO'])[1 + g % 5],
              'p' || g || '-' || $2::text || '@load.test', '010-' || lpad((g % 10000)::text, 4, '0') || '-' || lpad((g * 7 % 10000)::text, 4, '0'), 'scan'
       FROM generate_series(1, $4::int) g RETURNING id
     )
     SELECT count(*) FROM ins`,
    [userId, userId.slice(0, 8), pick(words, 1), N_CONTACTS],
  );
  await db.query(
    `INSERT INTO encounters (owner_user_id, contact_id, occurred_at, source, place_label, note)
     SELECT $1, c.id, now() - (random() * interval '700 days'), 'scan', (ARRAY[${places.map((p) => `'${p}'`).join(",")}])[1 + (abs(hashtext(c.id::text)) % ${places.length})],
            (ARRAY[${words.map((w) => `'${w} 관련 논의'`).join(",")}])[1 + (abs(hashtext(c.full_name)) % ${words.length})]
     FROM contacts c WHERE c.owner_user_id = $1`,
    [userId],
  );
  await db.query("INSERT INTO relationships (owner_user_id, contact_id, last_contact_at) SELECT $1, id, now() - random() * interval '300 days' FROM contacts WHERE owner_user_id=$1 ON CONFLICT DO NOTHING", [userId]);
  await db.query("INSERT INTO notes (owner_user_id, contact_id, body) SELECT $1, id, '투자 관심 · ' || full_name FROM contacts WHERE owner_user_id=$1 AND random() < 0.3", [userId]);
  // connected LINKOS peers with profiles + offers/needs for matching
  const peers = await db.query(
    `INSERT INTO users (email, display_name) SELECT 'peer' || g || '-' || $1::text || '@load.test', '피어' || g FROM generate_series(1, $2::int) g RETURNING id`,
    [userId.slice(0, 8), N_PEERS],
  );
  for (const [i, p] of peers.rows.entries()) {
    const prof = await db.query("INSERT INTO profiles (user_id, name, company, slug, is_primary, industries) VALUES ($1,$2,$3,$4,true,$5) RETURNING id", [p.id, `피어${i}`, `피어회사${i}`, `peer-${p.id.slice(0, 12)}`, [pick(words, i)]]);
    await db.query("INSERT INTO offers (profile_id, text) VALUES ($1,$2),($1,$3)", [prof.rows[0].id, `${pick(words, i)} 솔루션 공급`, `${pick(words, i + 3)} 유통망`]);
    await db.query("INSERT INTO needs (profile_id, text) VALUES ($1,$2)", [prof.rows[0].id, `${pick(words, i + 5)} 파트너`]);
    await db.query("INSERT INTO contacts (owner_user_id, linked_user_id, full_name, source) VALUES ($1,$2,$3,'exchange')", [userId, p.id, `피어${i}`]);
  }
  return Date.now() - t0;
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function run(name, fn) {
  const times = [];
  let errors = 0;
  let i = 0;
  const worker = async () => {
    while (i < REQS) {
      const n = i++;
      const t = performance.now();
      try {
        const r = await fn(n);
        if (!r.ok) errors++;
        await r.arrayBuffer();
      } catch {
        errors++;
      }
      times.push(performance.now() - t);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const total = (performance.now() - t0) / 1000;
  return { name, n: times.length, errors, p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), rps: times.length / total };
}

const u = await signup();
await fetch(`${BASE}/api/v1/profiles`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: u.cookie },
  body: JSON.stringify({ name: "부하테스트", company: "링코스", offers: ["의료 AI 솔루션"], needs: ["로봇 파트너", "물류 유통망"] }),
});
console.log(`seeding ${N_CONTACTS} contacts + ${N_PEERS} peers…`);
const seedMs = await seed(u.id);
console.log(`seeded in ${(seedMs / 1000).toFixed(1)}s; concurrency=${CONC}, requests/scenario=${REQS}`);
const H = { "content-type": "application/json", cookie: u.cookie };
const tokens = [];
const results = [];
results.push(
  await run("POST /exchange/sessions", async () => {
    const r = await fetch(`${BASE}/api/v1/exchange/sessions`, { method: "POST", headers: H, body: JSON.stringify({ capabilities: { webShare: true } }) });
    if (r.ok) {
      const b = await r.clone().json();
      tokens.push(b.token);
    }
    return r;
  }),
);
results.push(await run("GET guest landing (API)", (n) => fetch(`${BASE}/api/v1/exchange/sessions/${tokens[n % tokens.length]}`)));
results.push(await run("GET /x/{token} (guest SSR)", (n) => fetch(`${BASE}/x/${tokens[n % tokens.length]}`)));
results.push(await run("GET /contacts (list)", () => fetch(`${BASE}/api/v1/contacts?limit=100`, { headers: H })));
results.push(await run("GET /contacts?q=", (n) => fetch(`${BASE}/api/v1/contacts?q=${encodeURIComponent(`사람${n * 13}`)}`, { headers: H })));
results.push(await run("POST /ai/search", (n) => fetch(`${BASE}/api/v1/ai/search`, { method: "POST", headers: H, body: JSON.stringify({ query: `${pick(places, n)}에서 만난 ${pick(words, n)} 대표` }) })));
results.push(await run("GET /matches", () => fetch(`${BASE}/api/v1/matches`, { headers: H })));
results.push(await run("GET /app (home SSR)", () => fetch(`${BASE}/app`, { headers: H })));

let fail = false;
console.log("\nscenario                       n    err   p50ms   p95ms   p99ms    rps   SLO(p95)  result");
for (const r of results) {
  const slo = SLO[r.name];
  const ok = r.errors === 0 && r.p95 <= slo;
  if (!ok) fail = true;
  console.log(`${r.name.padEnd(28)} ${String(r.n).padStart(4)} ${String(r.errors).padStart(5)} ${r.p50.toFixed(0).padStart(7)} ${r.p95.toFixed(0).padStart(7)} ${r.p99.toFixed(0).padStart(7)} ${r.rps.toFixed(0).padStart(6)} ${String(slo).padStart(9)}  ${ok ? "PASS" : "FAIL"}`);
}
await db.end();
process.exit(fail ? 1 : 0);
