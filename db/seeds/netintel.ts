// 인적네트워크 인텔리전스 더미 데이터 (N-ID · docs/NETWORK_INTELLIGENCE.md).
//
// 목적: 빈 DB 에서도 모든 화면이 **의미 있는 상태**로 보이게 한다. 특히 다음을 눈으로 확인할 수 있어야 한다.
//   * masked discovery — 노현우(하노이 법인장)는 동료 소유 연락처라 `2촌 · 의료기기 · 임원/본부장 · 베트남 · 소개경로 있음`
//     으로만 보인다. 이름·회사·연락처는 어떤 응답에도 담기지 않는다.
//   * Top-K 대안 경로 — 같은 대상(하노이 법인장)으로 가는 경로가 3개 이상 생긴다.
//   * 커버리지 covered/partial/gap — 확정된 프로젝트에 세 상태가 모두 나타난다.
//   * 검토 대기 초안 — 두 번째 프로젝트는 요구사항이 확정되지 않은 상태로 둔다.
//   * 데이터 품질 — 일부러 중복 연락처와 끝난 소속을 하나씩 남겨 워커가 큐에 담도록 한다.
//
// 규칙(CLAUDE.md §3 · 기존 seed.ts 와 동일):
//   * 실제 개인정보 없음 — 모든 주소는 @example.test 다.
//   * 고정 UUID + ON CONFLICT / NOT EXISTS → 두 번 돌려도 변하지 않는다.
// `db/seeds` 는 패키지 밖이라 `@linkos/domain` 이 해석되지 않는다(workspace 링크는 services/api/node_modules 에만 있다).
// 기존 seed.ts 가 lib/db 를 상대경로로 가져오는 것과 같은 방식으로 도메인 사전을 직접 참조한다 —
// 산업 이름을 여기에 복사하면 taxonomy.ts 와 조용히 어긋날 수 있다.
import { normalizeCompanyName } from "../../packages/domain/src/normalize";
import { INDUSTRIES } from "../../packages/domain/src/taxonomy";
import type pg from "pg";

type Run = (table: string, sql: string, params?: unknown[]) => Promise<void>;

/** 고정 id. 화면·드릴·데모에서 그대로 참조할 수 있다. */
const N = {
  userC: "22222222-2222-4222-8222-333333333333",
  profileC: "33333333-3333-4333-8333-555555555555",
  org: "0a000000-0000-4000-8000-000000000001",
  co: {
    alpha: "0c000000-0000-4000-8000-000000000001", // 알파메디칼 — 의료기기 제조
    beta: "0c000000-0000-4000-8000-000000000002", // 베타유통 — 국내 유통
    hanoi: "0c000000-0000-4000-8000-000000000003", // 하노이메디 — 베트남 유통
    hospital: "0c000000-0000-4000-8000-000000000004", // 서울성심병원
    gamma: "0c000000-0000-4000-8000-000000000005", // 감마반도체
    delta: "0c000000-0000-4000-8000-000000000006", // 델타물류 — 콜드체인
    eco: "0c000000-0000-4000-8000-000000000007", // 에코소재 — 인허가/소재
    capital: "0c000000-0000-4000-8000-000000000008", // 캐피탈원 — VC
  },
  /** userA 의 1촌 */
  c: {
    doyun: "44444444-4444-4444-8444-444444444444", // 이도윤 (seed.ts 에서 이미 만든다)
    haneul: "44444444-4444-4444-8444-555555555555", // 박하늘 (seed.ts)
    minseo: "0b000000-0000-4000-8000-000000000001", // 최민서 — 병원 구매 과장(의사결정)
    woojin: "0b000000-0000-4000-8000-000000000002", // 정우진 — 베타유통 대표
    seoyeon: "0b000000-0000-4000-8000-000000000003", // 한서연 — 델타물류 영업이사
    jiho: "0b000000-0000-4000-8000-000000000004", // 오지호 — 캐피탈원 심사역
    gaon: "0b000000-0000-4000-8000-000000000005", // 윤가온 — 에코소재 대표
    taehyun: "0b000000-0000-4000-8000-000000000006", // 강태현 — 알파메디칼 CTO
    aram: "0b000000-0000-4000-8000-000000000007", // 서아람 — 병원 구매 담당
    hyunwoo: "0b000000-0000-4000-8000-000000000008", // 노현우 — 하노이메디 법인장 (masked 대상)
    sejin: "0b000000-0000-4000-8000-000000000009", // 임세진 — 베타유통 팀장
    eunbyul: "0b000000-0000-4000-8000-00000000000a", // 조은별 — 탐색 거부(어디에도 안 나온다)
    minseoDup: "0b000000-0000-4000-8000-00000000000b", // 최민서 중복 — 데이터 품질 큐 시연용
  },
  /** userC(조직 동료)의 연락처 — 진짜 2·3촌 경로를 만든다 */
  cc: {
    dohyun: "0b000000-0000-4000-8000-000000000011", // 백도현 — 하노이메디 대표 (조직 공유)
    chaewon: "0b000000-0000-4000-8000-000000000012", // 문채원 — 하노이메디 유통총괄 (연락처별 opt-in)
  },
  cap: {
    distribute: "0d000000-0000-4000-8000-000000000001",
    license: "0d000000-0000-4000-8000-000000000002",
    procure: "0d000000-0000-4000-8000-000000000003",
    coldchain: "0d000000-0000-4000-8000-000000000004",
    clinical: "0d000000-0000-4000-8000-000000000005",
    incorp: "0d000000-0000-4000-8000-000000000006",
    seriesA: "0d000000-0000-4000-8000-000000000007",
  },
  project: {
    vietnam: "0e000000-0000-4000-8000-000000000001",
    funding: "0e000000-0000-4000-8000-000000000002",
  },
  req: {
    partner: "0f000000-0000-4000-8000-000000000001", // need — 현지 유통 파트너 (covered)
    buyer: "0f000000-0000-4000-8000-000000000002", // role — 구매/조달 (covered)
    license: "0f000000-0000-4000-8000-000000000003", // need — 인허가 컨설팅 (partial)
    logistics: "0f000000-0000-4000-8000-000000000004", // need — 베트남 통관 (gap)
  },
  opp: {
    hanoi: "09000000-0000-4000-8000-000000000001",
    beta: "09000000-0000-4000-8000-000000000002",
    hospital: "09000000-0000-4000-8000-000000000003",
    won: "09000000-0000-4000-8000-000000000004",
  },
  icp: "08000000-0000-4000-8000-000000000001",
  search: {
    vietnam: "07000000-0000-4000-8000-000000000001",
    buyer: "07000000-0000-4000-8000-000000000002",
  },
} as const;

/** userA/userB 는 seed.ts 가 만든다. 여기서는 그 id 를 받아 쓴다. */
export async function seedNetworkIntel(db: pg.Pool, run: Run, userA: string, userB: string): Promise<void> {
  // ---------------------------------------------------------------- 분류 사전
  // 도메인 사전(taxonomy.ts)을 그대로 테이블에 넣는다. 두 쪽이 어긋나면 contact_industries 가 가리킬 값이 없다.
  await run(
    "industries",
    `INSERT INTO industries (name, name_en, taxonomy)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(name, name_en, taxonomy)
     ON CONFLICT (taxonomy, name) DO NOTHING`,
    [INDUSTRIES.map((i) => i.name), INDUSTRIES.map((i) => i.en), INDUSTRIES.map(() => "linkos")],
  );
  const indRows = await db.query<{ id: string; name: string }>("SELECT id, name FROM industries WHERE taxonomy='linkos'");
  const ind = new Map(indRows.rows.map((r) => [r.name, r.id]));
  const I = (name: string): string => {
    const id = ind.get(name);
    if (!id) throw new Error(`seed: industry '${name}' missing — taxonomy.ts 와 industries 테이블이 어긋났습니다`);
    return id;
  };

  // ---------------------------------------------------------------- 조직과 동료
  await run(
    "users",
    `INSERT INTO users (id, email, display_name, locale) VALUES ($1, 'colleague@example.test', '박지훈', 'ko-KR')
     ON CONFLICT (id) DO NOTHING`,
    [N.userC],
  );
  await run(
    "profiles",
    `INSERT INTO profiles (id, user_id, name, headline, visibility, is_primary, industries, regions)
     VALUES ($1, $2, '박지훈', '해외사업 담당', 'business', true, ARRAY['healthcare'], ARRAY['KR-11'])
     ON CONFLICT (id) DO NOTHING`,
    [N.profileC, N.userC],
  );
  await run(
    "organizations",
    `INSERT INTO organizations (id, name, slug, created_by, policies)
     VALUES ($1, '링코스랩', 'linkos-lab', $2, '{"graphPersonalExposure":"company_level"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [N.org, userA],
  );
  // graph_opt_out=false 인 동료만 조직 경유 탐색에 포함된다(N-202 consent-aware federation).
  await run(
    "organization_members",
    `INSERT INTO organization_members (organization_id, user_id, role, status, graph_opt_out) VALUES
       ($1, $2, 'owner', 'active', false),
       ($1, $3, 'member', 'active', false)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [N.org, userA, N.userC],
  );
  await run("users", `UPDATE users SET active_org_id = $1 WHERE id = ANY($2::uuid[]) AND active_org_id IS NULL`, [N.org, [userA, N.userC]]);

  // ---------------------------------------------------------------- 회사
  // companies 는 전역 테이블이고 normalized_name 에 UNIQUE 인덱스가 있다(0002). 그래서
  // 고정 id 로 ON CONFLICT 를 걸 수 없다 — 다른 테스트나 앱이 같은 회사를 먼저 만들어 두면
  // id 는 다르고 normalized_name 은 같아 삽입이 실패한다. 이름으로 충돌을 흡수한 뒤 실제 id 를 되읽는다.
  const COMPANIES: [key: keyof typeof N.co, name: string, domain: string, industry: string][] = [
    ["alpha", "알파메디칼", "alpha.example.test", "의료기기"],
    ["beta", "베타유통", "beta.example.test", "유통·도소매"],
    ["hanoi", "하노이메디", "hanoimedi.example.test", "의료기기"],
    ["hospital", "서울성심병원", "sshospital.example.test", "병원·의료서비스"],
    ["gamma", "감마반도체", "gamma.example.test", "반도체"],
    ["delta", "델타물류", "delta.example.test", "물류·운송"],
    ["eco", "에코소재", "eco.example.test", "화학·소재"],
    ["capital", "캐피탈원", "capitalone.example.test", "벤처투자·PE"],
  ];
  const norm = (name: string) => normalizeCompanyName(name) || name.toLowerCase();
  await run(
    "companies",
    `INSERT INTO companies (id, name, normalized_name, domain, industry)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(id, name, normalized_name, domain, industry)
     ON CONFLICT (normalized_name) DO NOTHING`,
    [
      COMPANIES.map((c) => N.co[c[0]]),
      COMPANIES.map((c) => c[1]),
      COMPANIES.map((c) => norm(c[1])),
      COMPANIES.map((c) => c[2]),
      COMPANIES.map((c) => c[3]),
    ],
  );
  const coRows = await db.query<{ id: string; normalized_name: string }>(
    "SELECT id, normalized_name FROM companies WHERE normalized_name = ANY($1::text[])",
    [COMPANIES.map((c) => norm(c[1]))],
  );
  const coByNorm = new Map(coRows.rows.map((r) => [r.normalized_name, r.id]));
  /** 논리 키 → 실제 회사 id. 빈 DB 면 위 고정 id 와 같고, 이미 있으면 기존 id 를 쓴다. */
  const CO = (key: keyof typeof N.co): string => {
    const spec = COMPANIES.find((c) => c[0] === key);
    const id = spec ? coByNorm.get(norm(spec[1])) : undefined;
    if (!id) throw new Error(`seed: company '${key}' 를 찾지 못했습니다`);
    return id;
  };
  await run(
    "company_industries",
    `INSERT INTO company_industries (company_id, industry_id, weight)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::numeric[]) AS t(company_id, industry_id, weight)
     ON CONFLICT (company_id, industry_id) DO NOTHING`,
    [
      [CO("alpha"), CO("beta"), CO("hanoi"), CO("hanoi"), CO("hospital"), CO("gamma"), CO("delta"), CO("eco"), CO("capital")],
      [I("의료기기"), I("유통·도소매"), I("의료기기"), I("유통·도소매"), I("병원·의료서비스"), I("반도체"), I("물류·운송"), I("화학·소재"), I("벤처투자·PE")],
      [1, 1, 0.7, 0.9, 1, 1, 1, 1, 1],
    ],
  );

  // ---------------------------------------------------------------- 연락처
  // address 가 지역 추론의 입력이다(loadNetwork → findRegions). 그래서 지역명을 분명히 적는다.
  type C = [id: string, owner: string, name: string, title: string, companyId: string, email: string, phone: string, address: string, source: string, scope: string];
  const contacts: C[] = [
    [N.c.minseo, userA, "최민서", "구매팀 과장", CO("hospital"), "minseo@sshospital.example.test", "010-0000-1001", "서울특별시 중구", "scan", "personal"],
    [N.c.woojin, userA, "정우진", "대표이사", CO("beta"), "woojin@beta.example.test", "010-0000-1002", "경기 성남시", "exchange", "personal"],
    [N.c.seoyeon, userA, "한서연", "영업이사", CO("delta"), "seoyeon@delta.example.test", "010-0000-1003", "인천 중구", "scan", "personal"],
    [N.c.jiho, userA, "오지호", "심사역", CO("capital"), "jiho@capitalone.example.test", "010-0000-1004", "서울특별시 강남구", "exchange", "personal"],
    [N.c.gaon, userA, "윤가온", "대표", CO("eco"), "gaon@eco.example.test", "010-0000-1005", "충청 천안시", "scan", "personal"],
    [N.c.taehyun, userA, "강태현", "CTO", CO("alpha"), "taehyun@alpha.example.test", "010-0000-1006", "서울특별시 금천구", "exchange", "personal"],
    [N.c.aram, userA, "서아람", "구매 담당", CO("hospital"), "aram@sshospital.example.test", "010-0000-1007", "서울특별시 중구", "import", "personal"],

    [N.c.sejin, userA, "임세진", "유통팀 팀장", CO("beta"), "sejin@beta.example.test", "010-0000-1009", "경기 성남시", "scan", "personal"],
    [N.c.eunbyul, userA, "조은별", "연구원", CO("gamma"), "eunbyul@gamma.example.test", "010-0000-1010", "경기 용인시", "scan", "personal"],
    // 중복: 최민서와 같은 이메일. N-024 데이터 품질 큐와 N-006 병합 검토를 시연한다.
    [N.c.minseoDup, userA, "최 민서", "구매 과장", CO("hospital"), "minseo@sshospital.example.test", "010-0000-1011", "서울특별시 중구", "import", "personal"],
    // 동료(userC)의 연락처 → userA 에게는 2·3촌이다.
    // 노현우는 조직 공유도 하지 않는다 — 내가 관찰한 who-knows-whom 엣지로만 닿으므로 끝까지 masked 다.
    [N.c.hyunwoo, N.userC, "노현우", "법인장", CO("hanoi"), "hyunwoo@hanoimedi.example.test", "010-0000-2003", "베트남 하노이", "scan", "personal"],
    [N.cc.dohyun, N.userC, "백도현", "대표이사", CO("hanoi"), "dohyun@hanoimedi.example.test", "010-0000-2001", "베트남 하노이", "exchange", "org"],
    [N.cc.chaewon, N.userC, "문채원", "유통총괄 이사", CO("hanoi"), "chaewon@hanoimedi.example.test", "010-0000-2002", "베트남 호치민", "scan", "personal"],
  ];
  await run(
    "contacts",
    `INSERT INTO contacts (id, owner_user_id, full_name, job_title, company_id, email, phone, address, source, scope, organization_id, field_provenance)
     SELECT t.id, t.owner, t.name, t.title, t.company_id, t.email, t.phone, t.address, t.source, t.scope,
            CASE WHEN t.scope = 'org' THEN $11::uuid ELSE NULL END,
            '{"email":{"provenance":"ocr","confidence":0.86},"phone":{"provenance":"ocr","confidence":0.79}}'::jsonb
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
         AS t(id, owner, name, title, company_id, email, phone, address, source, scope)
     ON CONFLICT (id) DO NOTHING`,
    [
      contacts.map((c) => c[0]),
      contacts.map((c) => c[1]),
      contacts.map((c) => c[2]),
      contacts.map((c) => c[3]),
      contacts.map((c) => c[4]),
      contacts.map((c) => c[5]),
      contacts.map((c) => c[6]),
      contacts.map((c) => c[7]),
      contacts.map((c) => c[8]),
      contacts.map((c) => c[9]),
      N.org,
    ],
  );

  // 내 1촌 관계. strength 는 워커(processStrengths)가 다시 계산하지만, 시드값이 있어야 첫 화면이 비지 않는다.
  const owned: [string, string, number, number][] = [
    [userA, N.c.minseo, 0.78, 6],
    [userA, N.c.woojin, 0.71, 12],
    [userA, N.c.seoyeon, 0.52, 40],
    [userA, N.c.jiho, 0.44, 25],
    [userA, N.c.gaon, 0.36, 95],
    [userA, N.c.taehyun, 0.83, 3],
    [userA, N.c.aram, 0.29, 120],
    [userA, N.c.sejin, 0.48, 30],
    [userA, N.c.eunbyul, 0.4, 60],
    [userA, N.c.minseoDup, 0.2, 200],
    [N.userC, N.c.hyunwoo, 0.66, 22],
    [N.userC, N.cc.dohyun, 0.74, 8],
    [N.userC, N.cc.chaewon, 0.61, 18],
  ];
  await run(
    "relationships",
    `INSERT INTO relationships (owner_user_id, contact_id, status, strength, last_contact_at)
     SELECT t.owner, t.contact, 'active', t.strength, now() - (t.days || ' days')::interval
       FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::int[]) AS t(owner, contact, strength, days)
     ON CONFLICT (owner_user_id, contact_id) DO NOTHING`,
    [owned.map((r) => r[0]), owned.map((r) => r[1]), owned.map((r) => r[2]), owned.map((r) => r[3])],
  );

  // ---------------------------------------------------------------- 산업·역할
  const ci: [string, string][] = [
    [N.c.minseo, "병원·의료서비스"],
    [N.c.woojin, "유통·도소매"],
    [N.c.seoyeon, "물류·운송"],
    [N.c.jiho, "벤처투자·PE"],
    [N.c.gaon, "화학·소재"],
    [N.c.taehyun, "의료기기"],
    [N.c.aram, "병원·의료서비스"],
    [N.c.hyunwoo, "의료기기"],
    [N.c.sejin, "유통·도소매"],
    [N.c.eunbyul, "반도체"],
    [N.cc.dohyun, "의료기기"],
    [N.cc.chaewon, "유통·도소매"],
  ];
  await run(
    "contact_industries",
    `INSERT INTO contact_industries (contact_id, industry_id, weight, source, confidence)
     SELECT t.contact, t.industry, 1.0, 'manual', 0.95
       FROM unnest($1::uuid[], $2::uuid[]) AS t(contact, industry)
     ON CONFLICT (contact_id, industry_id) DO NOTHING`,
    [ci.map((x) => x[0]), ci.map((x) => I(x[1]))],
  );

  // 소속 이력. 끝난 소속을 is_current 로 하나 남겨 데이터 품질 큐(stale_role)가 잡아내게 한다.
  type R = [contact: string, company: string, title: string, category: string, started: string, ended: string | null, current: boolean, decides: boolean];
  const roles: R[] = [
    [N.c.minseo, CO("hospital"), "구매팀 과장", "구매/조달", "2021-03-01", null, true, true],
    [N.c.woojin, CO("beta"), "대표이사", "대표/창업자", "2018-01-01", null, true, true],
    [N.c.seoyeon, CO("delta"), "영업이사", "임원/본부장", "2020-06-01", null, true, false],
    [N.c.jiho, CO("capital"), "심사역", "투자/심사", "2022-02-01", null, true, false],
    [N.c.gaon, CO("eco"), "대표", "대표/창업자", "2019-05-01", null, true, true],
    [N.c.taehyun, CO("alpha"), "CTO", "임원/본부장", "2020-01-01", null, true, false],
    [N.c.aram, CO("hospital"), "구매 담당", "구매/조달", "2023-01-01", null, true, false],
    [N.c.hyunwoo, CO("hanoi"), "법인장", "임원/본부장", "2022-09-01", null, true, true],
    [N.c.sejin, CO("beta"), "유통팀 팀장", "중간관리자", "2021-07-01", null, true, false],
    [N.cc.dohyun, CO("hanoi"), "대표이사", "대표/창업자", "2017-04-01", null, true, true],
    [N.cc.chaewon, CO("hanoi"), "유통총괄 이사", "임원/본부장", "2021-11-01", null, true, false],
    // 과거 소속(정상 종료) — Person 360 의 이력 표시용
    [N.c.taehyun, CO("gamma"), "선임 연구원", "엔지니어/연구", "2015-03-01", "2019-12-31", false, false],
    // 끝났는데 현재로 남아 있음 → stale_role 품질 항목이 만들어진다
    [N.c.eunbyul, CO("gamma"), "연구원", "엔지니어/연구", "2019-01-01", "2026-06-30", true, false],
  ];
  await run(
    "contact_company_roles",
    `INSERT INTO contact_company_roles (contact_id, company_id, title, role_category, started_on, ended_on, is_current, decides_for, source, provenance, confidence)
     SELECT t.contact, t.company, t.title, t.category, t.started::date, t.ended::date, t.current, t.decides, 'manual', 'user', 0.95
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::boolean[])
         AS t(contact, company, title, category, started, ended, current, decides)
      WHERE NOT EXISTS (
        SELECT 1 FROM contact_company_roles r
         WHERE r.contact_id = t.contact AND r.company_id = t.company AND r.title IS NOT DISTINCT FROM t.title)`,
    [roles.map((r) => r[0]), roles.map((r) => r[1]), roles.map((r) => r[2]), roles.map((r) => r[3]), roles.map((r) => r[4]), roles.map((r) => r[5]), roles.map((r) => r[6]), roles.map((r) => r[7])],
  );

  // ---------------------------------------------------------------- 역량과 Need
  const caps: [string, string, string][] = [
    [N.cap.distribute, "의료기기 유통", "distribution"],
    [N.cap.license, "의료기기 인허가 컨설팅", "regulatory"],
    [N.cap.procure, "병원 조달", "procurement"],
    [N.cap.coldchain, "콜드체인 물류", "logistics"],
    [N.cap.clinical, "임상 데이터 계약", "legal"],
    [N.cap.incorp, "베트남 현지 법인 설립", "operations"],
    [N.cap.seriesA, "시리즈A 투자", "finance"],
  ];
  await run(
    "capabilities",
    `INSERT INTO capabilities (id, owner_user_id, name, normalized_name, category)
     SELECT t.id, $4::uuid, t.name, lower(t.name), t.category
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, name, category)
     ON CONFLICT (id) DO NOTHING`,
    [caps.map((c) => c[0]), caps.map((c) => c[1]), caps.map((c) => c[2]), userA],
  );
  // provides = 상대가 줄 수 있는 것, needs = 상대가 찾는 것. 섞지 않는다(지침 §10).
  const links: [string, string, string][] = [
    [N.c.woojin, N.cap.distribute, "provides"],
    [N.c.hyunwoo, N.cap.distribute, "provides"],
    [N.cc.chaewon, N.cap.distribute, "provides"],
    [N.cc.dohyun, N.cap.incorp, "provides"],
    [N.c.gaon, N.cap.license, "provides"],
    [N.c.seoyeon, N.cap.coldchain, "provides"],
    [N.c.jiho, N.cap.seriesA, "provides"],
    [N.c.minseo, N.cap.procure, "needs"],
    [N.c.aram, N.cap.procure, "needs"],
    [N.c.hyunwoo, N.cap.license, "needs"],
    [N.c.taehyun, N.cap.clinical, "needs"],
  ];
  await run(
    "contact_capabilities",
    `INSERT INTO contact_capabilities (contact_id, capability_id, kind, confidence, provenance)
     SELECT t.contact, t.capability, t.kind, 0.9, 'user'
       FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS t(contact, capability, kind)
     ON CONFLICT (contact_id, capability_id, kind) DO NOTHING`,
    [links.map((l) => l[0]), links.map((l) => l[1]), links.map((l) => l[2])],
  );

  // ---------------------------------------------------------------- 공개 권한 (N-022)
  // 핵심 시연: 노현우/문채원은 path_only 라 masked 로만 보이고, 조은별은 탐색 자체가 막힌다.
  type SP = [contact: string, perm: string, optOut: boolean, orgOptIn: boolean | null];
  const perms: SP[] = [
    [N.c.hyunwoo, "path_only", false, null],
    [N.cc.chaewon, "path_only", false, true],
    [N.cc.dohyun, "contact", false, true],
    [N.c.minseo, "profile", false, null],
    [N.c.woojin, "introduction", false, null],
    [N.c.taehyun, "contact", false, null],
    [N.c.seoyeon, "profile", false, null],
    [N.c.jiho, "path_only", false, null],
    [N.c.gaon, "profile", false, null],
    [N.c.eunbyul, "none", true, null], // 당사자가 네트워크 탐색을 거부
  ];
  await run(
    "contact_share_permissions",
    `INSERT INTO contact_share_permissions (contact_id, share_permission, discovery_opt_out, org_share_opt_in, lawful_basis, policy_version, set_by_user_id)
     SELECT t.contact, t.perm, t.opt_out, t.org_opt_in, 'consent', '2026-10-01', $5::uuid
       FROM unnest($1::uuid[], $2::text[], $3::boolean[], $4::boolean[]) AS t(contact, perm, opt_out, org_opt_in)
     ON CONFLICT (contact_id) DO NOTHING`,
    [perms.map((p) => p[0]), perms.map((p) => p[1]), perms.map((p) => p[2]), perms.map((p) => p[3]), userA],
  );

  // ---------------------------------------------------------------- who-knows-whom (N-009)
  // 하노이메디 쪽으로 가는 경로를 **여러 개** 만든다 → Top-K 대안 경로 비교(S16)가 실제로 비교할 것이 생긴다.
  type E = [from: string, to: string, strength: number, confirmed: boolean, inferred: boolean, days: number, count: number];
  const edges: E[] = [
    [N.c.woojin, N.c.hyunwoo, 0.82, true, false, 20, 14], // 정우진 → 노현우 (가장 좋은 경로)
    [N.c.seoyeon, N.c.hyunwoo, 0.58, true, false, 160, 4], // 한서연 → 노현우 (휴면)
    [N.c.sejin, N.cc.chaewon, 0.64, false, true, 75, 3], // 임세진 → 문채원 (추정 관계)
    [N.c.woojin, N.cc.dohyun, 0.7, true, false, 45, 6], // 정우진 → 백도현
    [N.c.doyun, N.c.minseo, 0.76, true, false, 15, 9], // 이도윤 → 최민서
    [N.c.minseo, N.c.aram, 0.68, true, false, 10, 11], // 최민서 → 서아람
    [N.c.taehyun, N.c.haneul, 0.72, true, false, 30, 7],
    [N.c.haneul, N.c.eunbyul, 0.55, false, true, 90, 2],
    [N.c.jiho, N.c.gaon, 0.6, true, false, 50, 5],
    [N.c.gaon, N.c.hyunwoo, 0.46, false, true, 210, 2], // 윤가온 → 노현우 (약하고 추정)
  ];
  await run(
    "contact_relationships",
    `INSERT INTO contact_relationships (owner_user_id, from_contact_id, to_contact_id, rel_type, strength, confirmed, inferred,
                                        last_interaction_at, first_met_at, interaction_count, source)
     SELECT $8::uuid, t.from_c, t.to_c, 'knows', t.strength, t.confirmed, t.inferred,
            now() - (t.days || ' days')::interval, now() - interval '3 years', t.cnt, 'manual'
       FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::boolean[], $5::boolean[], $6::int[], $7::int[])
         AS t(from_c, to_c, strength, confirmed, inferred, days, cnt)
     ON CONFLICT (owner_user_id, from_contact_id, to_contact_id, rel_type) DO NOTHING`,
    [edges.map((e) => e[0]), edges.map((e) => e[1]), edges.map((e) => e[2]), edges.map((e) => e[3]), edges.map((e) => e[4]), edges.map((e) => e[5]), edges.map((e) => e[6]), userA],
  );

  // ---------------------------------------------------------------- Evidence (N-108)
  // 추천 이유는 evidenceId 에 연결되어야 하므로, 시드 후보에도 근거가 있어야 설명이 비지 않는다.
  type EV = [contact: string, type: string, summary: string, days: number, confidence: number, inferred: boolean];
  const evs: EV[] = [
    [N.c.minseo, "meeting", "최근 6개월 3회 미팅 — 조달 일정 협의", 20, 0.95, false],
    [N.c.minseo, "user_confirmed", "병원 구매 의사결정권자임을 직접 확인", 40, 1.0, false],
    [N.c.woojin, "referral", "지난 분기 유통 파트너 1건 소개 — 계약 성사", 60, 0.95, false],
    [N.c.woojin, "business_card", "코엑스 디지털헬스케어쇼에서 명함 교환", 180, 0.9, false],
    [N.c.hyunwoo, "company_data", "하노이메디 베트남 의료기기 유통 라이선스 보유", 90, 0.7, false],
    [N.c.hyunwoo, "ai_inferred", "직책·회사로 보아 현지 유통 의사결정 가능성 있음", 5, 0.45, true],
    [N.c.seoyeon, "interaction", "콜드체인 견적 문의 2회", 150, 0.8, false],
    [N.c.taehyun, "meeting", "주간 기술 리뷰 참석", 3, 0.95, false],
    [N.cc.dohyun, "org_membership", "같은 조직 동료가 공유한 연락처", 30, 0.85, false],
    [N.c.gaon, "note", "인허가 컨설팅 경험 언급(메모)", 95, 0.6, false],
  ];
  await run(
    "evidence_records",
    `INSERT INTO evidence_records (owner_user_id, entity_type, entity_id, evidence_type, summary, occurred_at, confidence, inferred, source)
     SELECT $7::uuid, 'contact', t.contact, t.type, t.summary, now() - (t.days || ' days')::interval, t.confidence, t.inferred, 'manual'
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::numeric[], $6::boolean[])
         AS t(contact, type, summary, days, confidence, inferred)
      WHERE NOT EXISTS (
        SELECT 1 FROM evidence_records e WHERE e.owner_user_id = $7::uuid AND e.entity_id = t.contact AND e.summary = t.summary)`,
    [evs.map((e) => e[0]), evs.map((e) => e[1]), evs.map((e) => e[2]), evs.map((e) => e[3]), evs.map((e) => e[4]), evs.map((e) => e[5]), userA],
  );

  // ---------------------------------------------------------------- 네트워크 활동 (N-109)
  // 1:1 을 3회 넣어 주기(cadence)가 계산되고, 소개 결과가 referral_success 신호로 들어간다.
  type ACT = [contact: string, type: string, days: number, minutes: number | null, outcome: string | null, org: string | null];
  const acts: ACT[] = [
    [N.c.doyun, "one_to_one", 160, 60, null, null],
    [N.c.doyun, "one_to_one", 95, 75, null, null],
    [N.c.doyun, "one_to_one", 28, 50, null, null],
    [N.c.minseo, "one_to_one", 20, 45, null, null],
    [N.c.woojin, "referral_given", 60, null, "won", null],
    [N.c.woojin, "referral_received", 120, null, "met", null],
    [N.c.seoyeon, "testimonial", 140, null, null, null],
    [N.c.taehyun, "group_meeting", 7, 90, null, N.org],
    [N.c.jiho, "follow_up", 25, null, null, null],
    [N.c.gaon, "referral_given", 100, null, "declined", null],
  ];
  await run(
    "network_activities",
    `INSERT INTO network_activities (owner_user_id, contact_id, organization_id, activity_type, occurred_at, duration_minutes, outcome, note)
     SELECT $7::uuid, t.contact, t.org, t.type, now() - (t.days || ' days')::interval, t.minutes, t.outcome, NULL
       FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[], $5::text[], $6::uuid[])
         AS t(contact, type, days, minutes, outcome, org)
      WHERE NOT EXISTS (
        SELECT 1 FROM network_activities a
         WHERE a.owner_user_id = $7::uuid AND a.contact_id = t.contact AND a.activity_type = t.type
           AND a.occurred_at::date = (now() - (t.days || ' days')::interval)::date)`,
    [acts.map((a) => a[0]), acts.map((a) => a[1]), acts.map((a) => a[2]), acts.map((a) => a[3]), acts.map((a) => a[4]), acts.map((a) => a[5]), userA],
  );

  // ---------------------------------------------------------------- 프로젝트 (N-018 / N-019)
  await run(
    "projects",
    `INSERT INTO projects (id, owner_user_id, organization_id, name, description, status, target_regions, target_industries, deadline, requirements_confirmed_at) VALUES
       ($1, $3, $4, '베트남 의료기기 유통 진출',
        E'현지 유통 파트너가 필요합니다.\\n병원 구매 담당자를 소개받고 싶습니다.\\n반드시 의료기기 인허가 컨설팅이 필요해요.\\n베트남 통관을 처리할 곳을 찾고 있습니다.',
        'active', ARRAY['베트남'], ARRAY['의료기기'], current_date + 90, now() - interval '2 days'),
       ($2, $3, $4, '시리즈A 라운드',
        E'헬스케어 분야 투자사를 찾고 있습니다.\\n임상 데이터 계약을 검토할 법률 자문이 필요합니다.',
        'active', ARRAY['서울'], ARRAY['의료기기'], current_date + 150, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [N.project.vietnam, N.project.funding, userA, N.org],
  );
  // 첫 프로젝트는 확정된 요구사항(accepted_at), 두 번째는 분석 전 상태로 둬 "검토 필요" UI 가 보이게 한다.
  type REQ = [id: string, kind: string, name: string, priority: number, industry: string | null, region: string | null, sentence: string];
  const reqs: REQ[] = [
    [N.req.partner, "need", "현지 유통 파트너가 필요합니다", 1, "유통·도소매", "베트남", "현지 유통 파트너가 필요합니다."],
    [N.req.buyer, "role", "구매/조달", 2, "병원·의료서비스", "서울", "병원 구매 담당자를 소개받고 싶습니다."],
    [N.req.license, "need", "의료기기 인허가 컨설팅이 필요해요", 1, "의료기기", "베트남", "반드시 의료기기 인허가 컨설팅이 필요해요."],
    [N.req.logistics, "need", "베트남 통관을 처리할 곳을 찾고 있습니다", 2, "물류·운송", "베트남", "베트남 통관을 처리할 곳을 찾고 있습니다."],
  ];
  await run(
    "project_requirements",
    `INSERT INTO project_requirements (id, project_id, kind, name, description, priority, industry, region, source_sentence, provenance, accepted_at)
     SELECT t.id, $8::uuid, t.kind, t.name, t.sentence, t.priority, t.industry, t.region, t.sentence, 'rule_parsed', now() - interval '2 days'
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[])
         AS t(id, kind, name, priority, industry, region, sentence)
     ON CONFLICT (id) DO NOTHING`,
    [reqs.map((r) => r[0]), reqs.map((r) => r[1]), reqs.map((r) => r[2]), reqs.map((r) => r[3]), reqs.map((r) => r[4]), reqs.map((r) => r[5]), reqs.map((r) => r[6]), N.project.vietnam],
  );

  // ---------------------------------------------------------------- 기회 보드 (N-021)
  // 칼럼마다 카드가 하나씩 있어야 보드가 비어 보이지 않는다. 체류 일수를 다르게 줘 stale 표시도 보이게 한다.
  type OPP = [id: string, contact: string, req: string | null, stage: string, days: number, score: number];
  const opps: OPP[] = [
    [N.opp.hanoi, N.c.hyunwoo, N.req.partner, "detected", 12, 71.4], // 12일 체류 → stale 표시(SLA 7일)
    [N.opp.beta, N.c.woojin, N.req.partner, "qualified", 4, 83.2],
    [N.opp.hospital, N.c.minseo, N.req.buyer, "intro_requested", 6, 78.9],
    [N.opp.won, N.c.taehyun, null, "won", 30, 88.1],
  ];
  await run(
    "opportunities",
    `INSERT INTO opportunities (id, owner_user_id, project_id, requirement_id, target_contact_id, stage, stage_entered_at, recommendation_score, explanation)
     SELECT t.id, $7::uuid, $8::uuid, t.req, t.contact, t.stage, now() - (t.days || ' days')::interval, t.score,
            jsonb_build_object('scoreComponents', jsonb_build_object('intentFit', 0.82, 'capabilityFit', 0.74, 'pathQuality', 0.61, 'relationshipStrength', 0.48),
                               'model', 'reco-v1')
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::int[], $6::numeric[])
         AS t(id, contact, req, stage, days, score)
     ON CONFLICT (id) DO NOTHING`,
    [opps.map((o) => o[0]), opps.map((o) => o[1]), opps.map((o) => o[2]), opps.map((o) => o[3]), opps.map((o) => o[4]), opps.map((o) => o[5]), userA, N.project.vietnam],
  );

  // 학습 라벨 — funnel 결과가 있어야 추천 가중치 재조정 파이프라인이 입력을 갖는다(지침 §6).
  await run(
    "recommendation_feedback",
    `INSERT INTO recommendation_feedback (owner_user_id, subject_type, subject_id, label, score_components, model_version)
     SELECT $1::uuid, 'opportunity', v.subject, v.label, '{"intentFit":0.82,"pathQuality":0.61}'::jsonb, 'reco-v1'
       FROM (VALUES ($2::uuid, 'qualified'::text), ($3::uuid, 'intro_requested'), ($4::uuid, 'won')) AS v(subject, label)
      WHERE NOT EXISTS (
        SELECT 1 FROM recommendation_feedback f WHERE f.subject_id = v.subject AND f.label = v.label)`,
    [userA, N.opp.beta, N.opp.hospital, N.opp.won],
  );

  // ---------------------------------------------------------------- 저장된 검색 (N-106)
  await run(
    "saved_searches",
    `INSERT INTO saved_searches (id, owner_user_id, name, query, intent, alert_enabled, alert_frequency) VALUES
       ($1, $3, '베트남 의료기기 유통', '베트남에서 의료기기를 유통할 회사를 내 3촌 안에서 찾아줘', '{}'::jsonb, true, 'weekly'),
       ($2, $3, '병원 구매 담당자', '서울 병원 구매 담당자를 2촌 안에서 찾아줘', '{}'::jsonb, false, 'monthly')
     ON CONFLICT (id) DO NOTHING`,
    [N.search.vietnam, N.search.buyer, userA],
  );

  // ---------------------------------------------------------------- ICP (N-110)
  await run(
    "ideal_customer_profiles",
    `INSERT INTO ideal_customer_profiles (id, owner_user_id, name, industries, regions, role_categories, needs, description, is_default)
     VALUES ($1, $2, '국내 병원 조달 담당', ARRAY['병원·의료서비스','의료기기'], ARRAY['서울','경기'], ARRAY['구매/조달'],
             ARRAY['의료기기 조달','영상 판독 보조'], '영상 판독 보조 모델을 도입할 병원의 구매 의사결정자', true)
     ON CONFLICT (id) DO NOTHING`,
    [N.icp, userA],
  );

  // ---------------------------------------------------------------- 분류 별칭 (N-107)
  // 사전에 없는 사내 표현만 등록한다(사전에 있는 값은 addAlias 가 거부한다).
  await run(
    "taxonomy_aliases",
    `INSERT INTO taxonomy_aliases (owner_user_id, organization_id, kind, alias, normalized_alias, canonical_name, locale)
     SELECT CASE WHEN v.org THEN NULL ELSE $1::uuid END, CASE WHEN v.org THEN $2::uuid ELSE NULL END,
            v.kind, v.alias, lower(v.alias), v.canonical, 'ko'
       FROM (VALUES ('industry'::text, '메디텍'::text, '의료기기'::text, true),
                    ('region', '동남아', '베트남', true),
                    ('role', '핵심고객', '구매/조달', false)) AS v(kind, alias, canonical, org)
      WHERE NOT EXISTS (
        SELECT 1 FROM taxonomy_aliases a WHERE a.normalized_alias = lower(v.alias) AND a.kind = v.kind)`,
    [userA, N.org],
  );

  // ---------------------------------------------------------------- 신호 샘플 (N-103 추세)
  // 추세선이 한 점만 있으면 "변화"를 보여줄 수 없다. 최근 3개월치를 월별로 남긴다.
  await run(
    "relationship_signal_samples",
    `INSERT INTO relationship_signal_samples (owner_user_id, relationship_id, signal_type, value, measured_at, model_version)
     SELECT $1::uuid, r.id, s.signal_type, s.value, now() - (s.months || ' months')::interval, 'rel-strength-v1'
       FROM relationships r
       CROSS JOIN (VALUES ('frequency'::text, 0.35::numeric, 3), ('frequency', 0.5, 2), ('frequency', 0.7, 1),
                          ('recency', 0.4, 3), ('recency', 0.62, 2), ('recency', 0.85, 1)) AS s(signal_type, value, months)
      WHERE r.owner_user_id = $1::uuid AND r.contact_id = $2::uuid
        AND NOT EXISTS (
          SELECT 1 FROM relationship_signal_samples x
           WHERE x.relationship_id = r.id AND x.model_version = 'rel-strength-v1')`,
    [userA, N.c.minseo],
  );
}

export const NETINTEL_SEED_IDS = N;
