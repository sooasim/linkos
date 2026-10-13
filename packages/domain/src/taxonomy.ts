// N-011 산업/역량/Need 분류 체계 · N-107 다국어 별칭(entity alias).
// 지침: docs/NETWORK_INTELLIGENCE.md §10 — Capability(제공 가능한 것)와 Need(필요한 것)를 섞지 않는다.
//
// 자유 텍스트를 canonical 값으로 정규화한다. 사전에 없는 값은 **지어내지 않고** null 을 돌려준다 —
// 그러면 호출자는 자유 텍스트로 보존한다(사실 필드를 추측하지 않는다는 원칙).

export interface TaxonomyEntry {
  /** canonical 한국어 이름 — 저장·표시의 기준값 */
  name: string;
  /** 영어 이름(검색·국제화) */
  en: string;
  /** 매칭용 별칭. 소문자 비교한다 */
  aliases: string[];
  /** 상위 분류 */
  parent?: string;
}

// ---------- 산업 ----------

export const INDUSTRIES: TaxonomyEntry[] = [
  { name: "의료기기", en: "Medical Devices", aliases: ["medical device", "메디컬", "의료장비", "의료 기기", "헬스케어 기기"], parent: "헬스케어" },
  { name: "제약·바이오", en: "Pharma & Biotech", aliases: ["제약", "바이오", "biotech", "pharma", "신약", "바이오텍"], parent: "헬스케어" },
  { name: "병원·의료서비스", en: "Healthcare Services", aliases: ["병원", "의료 서비스", "클리닉", "hospital", "healthcare service"], parent: "헬스케어" },
  { name: "소프트웨어·SaaS", en: "Software & SaaS", aliases: ["소프트웨어", "saas", "software", "it", "아이티", "솔루션"], parent: "정보기술" },
  { name: "인공지능·데이터", en: "AI & Data", aliases: ["ai", "인공지능", "머신러닝", "machine learning", "데이터 분석", "빅데이터", "llm"], parent: "정보기술" },
  { name: "반도체", en: "Semiconductor", aliases: ["semiconductor", "파운드리", "foundry", "칩", "웨이퍼"], parent: "제조" },
  { name: "전자·부품", en: "Electronics & Components", aliases: ["전자", "electronics", "부품", "pcb", "디스플레이"], parent: "제조" },
  { name: "기계·장비", en: "Machinery", aliases: ["기계", "machinery", "장비", "설비", "공작기계"], parent: "제조" },
  { name: "자동차·모빌리티", en: "Automotive & Mobility", aliases: ["자동차", "automotive", "모빌리티", "mobility", "전기차", "ev"], parent: "제조" },
  { name: "화학·소재", en: "Chemicals & Materials", aliases: ["화학", "chemical", "소재", "materials", "배터리 소재"], parent: "제조" },
  { name: "이차전지", en: "Battery", aliases: ["배터리", "battery", "이차 전지", "2차전지"], parent: "제조" },
  { name: "식품·음료", en: "Food & Beverage", aliases: ["식품", "food", "음료", "beverage", "f&b", "외식"] },
  { name: "화장품·뷰티", en: "Cosmetics & Beauty", aliases: ["화장품", "cosmetic", "뷰티", "beauty", "스킨케어"] },
  { name: "패션·의류", en: "Fashion & Apparel", aliases: ["패션", "fashion", "의류", "apparel", "어패럴"] },
  { name: "유통·도소매", en: "Distribution & Retail", aliases: ["유통", "distribution", "도매", "소매", "retail", "리테일", "총판", "대리점"] },
  { name: "이커머스", en: "E-commerce", aliases: ["이커머스", "e-commerce", "ecommerce", "온라인 쇼핑", "커머스"], parent: "유통·도소매" },
  { name: "물류·운송", en: "Logistics", aliases: ["물류", "logistics", "운송", "배송", "포워딩", "forwarding", "3pl"] },
  { name: "무역·수출입", en: "Trade", aliases: ["무역", "trade", "수출", "수입", "export", "import", "수출입"] },
  { name: "건설·부동산", en: "Construction & Real Estate", aliases: ["건설", "construction", "부동산", "real estate", "시공", "디벨로퍼"] },
  { name: "에너지·환경", en: "Energy & Environment", aliases: ["에너지", "energy", "환경", "태양광", "solar", "재생에너지", "esg"] },
  { name: "금융·은행", en: "Banking & Finance", aliases: ["금융", "finance", "은행", "bank", "캐피탈", "대출"] },
  { name: "벤처투자·PE", en: "VC & PE", aliases: ["vc", "벤처캐피탈", "벤처 투자", "사모", "pe", "private equity", "액셀러레이터", "투자사"], parent: "금융·은행" },
  { name: "보험", en: "Insurance", aliases: ["보험", "insurance", "손해보험", "생명보험"], parent: "금융·은행" },
  { name: "법률·회계·컨설팅", en: "Professional Services", aliases: ["법률", "법무", "law firm", "회계", "세무", "컨설팅", "consulting", "자문"] },
  { name: "마케팅·광고", en: "Marketing & Advertising", aliases: ["마케팅", "marketing", "광고", "advertising", "퍼포먼스 마케팅", "브랜딩"] },
  { name: "미디어·콘텐츠", en: "Media & Content", aliases: ["미디어", "media", "콘텐츠", "content", "방송", "출판", "엔터테인먼트"] },
  { name: "게임", en: "Gaming", aliases: ["게임", "game", "gaming", "e스포츠"] },
  { name: "교육", en: "Education", aliases: ["교육", "education", "에듀테크", "edtech", "학원", "대학"] },
  { name: "공공·정부", en: "Public Sector", aliases: ["공공", "정부", "government", "지자체", "공기업", "조달"] },
  { name: "농업·수산", en: "Agriculture & Fisheries", aliases: ["농업", "agriculture", "수산", "축산", "농수산"] },
  { name: "관광·호텔", en: "Travel & Hospitality", aliases: ["관광", "travel", "호텔", "hotel", "여행", "숙박"] },
  { name: "통신", en: "Telecom", aliases: ["통신", "telecom", "이동통신", "5g", "네트워크 장비"] },
];

// ---------- 지역 ----------

export const REGIONS: TaxonomyEntry[] = [
  { name: "서울", en: "Seoul", aliases: ["seoul", "서울시", "서울특별시"], parent: "대한민국" },
  { name: "경기", en: "Gyeonggi", aliases: ["gyeonggi", "경기도", "수원", "성남", "판교", "용인", "고양"], parent: "대한민국" },
  { name: "인천", en: "Incheon", aliases: ["incheon", "인천시"], parent: "대한민국" },
  { name: "부산", en: "Busan", aliases: ["busan", "부산시"], parent: "대한민국" },
  { name: "대구", en: "Daegu", aliases: ["daegu"], parent: "대한민국" },
  { name: "대전", en: "Daejeon", aliases: ["daejeon", "대덕"], parent: "대한민국" },
  { name: "광주", en: "Gwangju", aliases: ["gwangju"], parent: "대한민국" },
  { name: "울산", en: "Ulsan", aliases: ["ulsan"], parent: "대한민국" },
  { name: "충청", en: "Chungcheong", aliases: ["충남", "충북", "천안", "청주", "chungcheong"], parent: "대한민국" },
  { name: "전라", en: "Jeolla", aliases: ["전남", "전북", "전주", "여수", "jeolla"], parent: "대한민국" },
  { name: "경상", en: "Gyeongsang", aliases: ["경남", "경북", "창원", "포항", "구미", "gyeongsang"], parent: "대한민국" },
  { name: "강원", en: "Gangwon", aliases: ["gangwon", "춘천", "원주"], parent: "대한민국" },
  { name: "제주", en: "Jeju", aliases: ["jeju"], parent: "대한민국" },
  { name: "대한민국", en: "South Korea", aliases: ["한국", "korea", "south korea", "국내", "kr"] },
  { name: "일본", en: "Japan", aliases: ["japan", "도쿄", "tokyo", "오사카", "osaka", "jp"] },
  { name: "중국", en: "China", aliases: ["china", "베이징", "상하이", "shanghai", "shenzhen", "선전", "cn"] },
  { name: "대만", en: "Taiwan", aliases: ["taiwan", "타이완", "타이베이", "taipei"] },
  { name: "베트남", en: "Vietnam", aliases: ["vietnam", "viet nam", "하노이", "hanoi", "호치민", "ho chi minh", "vn"] },
  { name: "태국", en: "Thailand", aliases: ["thailand", "방콕", "bangkok"] },
  { name: "인도네시아", en: "Indonesia", aliases: ["indonesia", "자카르타", "jakarta"] },
  { name: "싱가포르", en: "Singapore", aliases: ["singapore", "싱가폴", "sg"] },
  { name: "말레이시아", en: "Malaysia", aliases: ["malaysia", "쿠알라룸푸르"] },
  { name: "필리핀", en: "Philippines", aliases: ["philippines", "마닐라", "manila"] },
  { name: "인도", en: "India", aliases: ["india", "델리", "뭄바이", "방갈로르", "bangalore"] },
  { name: "미국", en: "United States", aliases: ["usa", "us", "united states", "america", "실리콘밸리", "silicon valley", "뉴욕", "new york", "캘리포니아"] },
  { name: "캐나다", en: "Canada", aliases: ["canada", "토론토", "밴쿠버"] },
  { name: "멕시코", en: "Mexico", aliases: ["mexico", "멕시코시티"] },
  { name: "브라질", en: "Brazil", aliases: ["brazil", "상파울루"] },
  { name: "독일", en: "Germany", aliases: ["germany", "베를린", "berlin", "뮌헨", "munich"] },
  { name: "영국", en: "United Kingdom", aliases: ["uk", "united kingdom", "england", "런던", "london"] },
  { name: "프랑스", en: "France", aliases: ["france", "파리", "paris"] },
  { name: "유럽", en: "Europe", aliases: ["europe", "eu", "구주"] },
  { name: "중동", en: "Middle East", aliases: ["middle east", "두바이", "dubai", "사우디", "saudi", "uae", "아랍에미리트"] },
  { name: "호주", en: "Australia", aliases: ["australia", "시드니", "sydney", "멜버른"] },
  { name: "아프리카", en: "Africa", aliases: ["africa", "나이지리아", "케냐", "남아공"] },
];

// ---------- 역할 ----------

export const ROLE_CATEGORIES: TaxonomyEntry[] = [
  { name: "대표/창업자", en: "Founder / CEO", aliases: ["대표", "대표이사", "ceo", "founder", "창업자", "사장", "회장", "owner", "오너"] },
  { name: "임원/본부장", en: "Executive", aliases: ["임원", "이사", "상무", "전무", "부사장", "본부장", "cto", "cfo", "coo", "cmo", "ciso", "cio", "vp", "chief", "head of", "실장"] },
  { name: "중간관리자", en: "Manager", aliases: ["팀장", "부장", "차장", "과장", "manager", "매니저", "lead", "리드", "파트장", "그룹장"] },
  { name: "구매/조달", en: "Procurement", aliases: ["구매", "조달", "purchasing", "procurement", "소싱", "sourcing", "바이어", "buyer"] },
  { name: "영업/사업개발", en: "Sales / BD", aliases: ["영업", "sales", "세일즈", "사업개발", "business development", "bd", "제휴", "파트너십", "partnership"] },
  { name: "엔지니어/연구", en: "Engineering / R&D", aliases: ["개발", "개발자", "엔지니어", "engineer", "developer", "연구", "연구원", "researcher", "r&d", "기술"] },
  { name: "마케팅/홍보", en: "Marketing / PR", aliases: ["마케팅", "marketing", "홍보", "pr", "브랜드", "커뮤니케이션"] },
  { name: "디자인", en: "Design", aliases: ["디자이너", "디자인", "design", "ux", "ui"] },
  { name: "재무/회계", en: "Finance", aliases: ["재무", "회계", "경리", "finance", "accounting", "세무"] },
  { name: "인사/채용", en: "HR", aliases: ["인사", "채용", "hr", "people", "recruiter", "리크루터"] },
  { name: "법무", en: "Legal", aliases: ["법무", "변호사", "legal", "counsel", "특허", "변리사"] },
  { name: "투자/심사", en: "Investor", aliases: ["투자", "심사역", "investor", "partner", "파트너", "애널리스트", "analyst"] },
];

// ---------- 정규화 ----------

const norm = (s: string): string => s.toLowerCase().replace(/[\s·_/-]+/g, " ").trim();

function buildIndex(entries: TaxonomyEntry[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const e of entries) {
    idx.set(norm(e.name), e.name);
    idx.set(norm(e.en), e.name);
    for (const a of e.aliases) idx.set(norm(a), e.name);
  }
  return idx;
}

const INDUSTRY_IDX = buildIndex(INDUSTRIES);
const REGION_IDX = buildIndex(REGIONS);
const ROLE_IDX = buildIndex(ROLE_CATEGORIES);

/** 정확히 일치하는 별칭이 있을 때만 canonical 이름을 돌려준다. 없으면 null(추측 금지). */
export function normalizeIndustry(text: string | null | undefined): string | null {
  return text ? (INDUSTRY_IDX.get(norm(text)) ?? null) : null;
}
export function normalizeRegion(text: string | null | undefined): string | null {
  return text ? (REGION_IDX.get(norm(text)) ?? null) : null;
}
export function normalizeRole(text: string | null | undefined): string | null {
  return text ? (ROLE_IDX.get(norm(text)) ?? null) : null;
}

/**
 * 문장 안에서 분류값을 찾는다(부분 문자열 매칭). 긴 별칭을 먼저 시도해 "의료기기"가 "의료"보다 우선되게 한다.
 * 반환 순서는 사전 정의 순서이며 중복은 제거한다 — 같은 질의면 항상 같은 결과가 나와야 한다(결정적).
 */
export function findInText(text: string, entries: TaxonomyEntry[]): string[] {
  const hay = norm(text);
  const found = new Set<string>();
  for (const e of entries) {
    const needles = [e.name, e.en, ...e.aliases].map(norm).sort((a, b) => b.length - a.length);
    for (const n of needles) {
      if (n.length >= 2 && hay.includes(n)) {
        found.add(e.name);
        break;
      }
    }
  }
  return entries.filter((e) => found.has(e.name)).map((e) => e.name);
}

export const findIndustries = (text: string): string[] => findInText(text, INDUSTRIES);
export const findRegions = (text: string): string[] => findInText(text, REGIONS);
export const findRoles = (text: string): string[] => findInText(text, ROLE_CATEGORIES);

/**
 * 직급보다 직무를 먼저 본다. "구매팀 과장" 은 '중간관리자'보다 '구매/조달'이 쓸모 있는 정보다 —
 * 네트워크 검색이 찾는 것은 직급이 아니라 "무엇을 담당하는 사람인가"이기 때문이다.
 * 의사결정 권한은 직급으로 추측하지 않고 `contact_company_roles.decides_for` 로 따로 기록한다.
 * 다만 소유자급(대표/창업자)은 직무보다 먼저다 — 그 자체가 결정권을 뜻한다.
 */
const ROLE_PRIORITY: string[] = [
  "대표/창업자",
  "구매/조달",
  "투자/심사",
  "법무",
  "재무/회계",
  "인사/채용",
  "영업/사업개발",
  "마케팅/홍보",
  "디자인",
  "엔지니어/연구",
  "임원/본부장",
  "중간관리자",
];

/**
 * 직책 텍스트에서 역할 카테고리를 추론한다. `ROLE_CATEGORIES` 의 별칭을 그대로 쓰므로
 * 분류 사전과 masked 라벨이 어긋나지 않는다(두 군데에 역할 목록을 두면 한쪽만 바뀐다).
 * 직책이 없으면 null, 사전에 걸리지 않으면 `실무자` 다.
 */
export function roleCategory(title: string | null | undefined): string | null {
  if (!title) return null;
  const hay = norm(title);
  for (const name of ROLE_PRIORITY) {
    const e = ROLE_CATEGORIES.find((c) => c.name === name);
    if (!e) continue;
    const needles = [e.name, e.en, ...e.aliases].map(norm).filter((x) => x.length >= 2);
    if (needles.some((x) => hay.includes(x))) return name;
  }
  return "실무자";
}

/** 상위 분류를 포함한 산업 집합(의료기기 → 의료기기 + 헬스케어). 산업 적합도 계산에 쓴다. */
export function industryWithParents(name: string): string[] {
  const e = INDUSTRIES.find((x) => x.name === name);
  return e?.parent ? [e.name, e.parent] : e ? [e.name] : [];
}

/** 역량/Need 자유 텍스트의 중복 제거 키. 저장 전 normalized_name 으로 쓴다. */
export function canonicalKey(text: string): string {
  return norm(text).replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

// ---------- N-107 사용자·조직 별칭 ----------

export const ALIAS_KINDS = ["industry", "region", "role", "capability"] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export interface TaxonomyAlias {
  kind: AliasKind;
  /** 사용자가 쓰는 표현 */
  alias: string;
  /** 매핑되는 canonical 값. industry/region/role 은 위 사전의 name 이어야 한다 */
  canonicalName: string;
}

/** 저장 전 정규화 키. DB 의 normalized_alias 컬럼과 같은 값이어야 한다. */
export function normalizeAlias(alias: string): string {
  return norm(alias);
}

/**
 * 별칭이 사전 밖 표현을 흡수하게 해 준다. 예: 조직이 "메디텍"을 "의료기기"로 등록하면
 * 그 조직 구성원의 질의에서 "메디텍"이 산업 조건으로 잡힌다.
 *
 * canonical 값이 사전에 없으면 **무시한다** — 사전 밖 값을 통과시키면 추천 feature 가 조용히 어긋난다.
 */
export function findWithAliases(text: string, kind: AliasKind, aliases: TaxonomyAlias[] = []): string[] {
  const base = kind === "industry" ? findIndustries(text) : kind === "region" ? findRegions(text) : kind === "role" ? findRoles(text) : [];
  const dict = kind === "industry" ? INDUSTRY_IDX : kind === "region" ? REGION_IDX : kind === "role" ? ROLE_IDX : null;
  const hay = norm(text);
  const out = [...base];
  for (const a of aliases) {
    if (a.kind !== kind) continue;
    const needle = norm(a.alias);
    if (needle.length < 2 || !hay.includes(needle)) continue;
    // capability 는 자유 텍스트라 사전 검증 없이 canonical 값을 그대로 쓴다
    const canonical = dict ? dict.get(norm(a.canonicalName)) : a.canonicalName;
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** 별칭 입력이 쓸 수 있는 값인지 검사한다. 저장 전에 호출한다. */
export function validateAlias(a: TaxonomyAlias): { ok: boolean; reason?: string; canonicalName?: string } {
  if (!(ALIAS_KINDS as readonly string[]).includes(a.kind)) return { ok: false, reason: "invalid_kind" };
  if (normalizeAlias(a.alias).length < 2) return { ok: false, reason: "alias_too_short" };
  if (a.kind === "capability") return { ok: true, canonicalName: a.canonicalName.trim() };
  const dict = a.kind === "industry" ? INDUSTRY_IDX : a.kind === "region" ? REGION_IDX : ROLE_IDX;
  const canonical = dict.get(norm(a.canonicalName));
  if (!canonical) return { ok: false, reason: "unknown_canonical" };
  // 사전에 이미 있는 표현을 별칭으로 다시 등록하는 것은 막는다(중복·모순 방지)
  if (dict.get(normalizeAlias(a.alias))) return { ok: false, reason: "already_in_dictionary" };
  return { ok: true, canonicalName: canonical };
}
