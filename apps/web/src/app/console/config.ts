// LINKOS console — role config, route map, and synthetic demo data.
// Ported from prototype/assets/dashboard-suite.js (ROLES, model, orgs). All data is SYNTHETIC.
// Routes mirror uiux/SCREEN_CATALOG.csv Target_Route under the dedicated /console namespace.

export type Role = "member" | "chapter" | "tenant" | "platform";

export type NavItem = { key: string; title: string; icon: string };
export type RoleConfig = { name: string; who: string; caption: string; account: string; nav: NavItem[] };

export const ROLES: Record<Role, RoleConfig> = {
  member: {
    name: "일반 회원",
    who: "가상마케팅 / 김회원",
    caption: "MEMBER WORKSPACE",
    account: "김회원",
    nav: [
      { key: "home", title: "내 대시보드", icon: "grid" },
      { key: "meetings", title: "나의 모임·1:1", icon: "calendar" },
      { key: "referrals", title: "사업 소개·승인", icon: "link" },
      { key: "directory", title: "기업 탐색", icon: "building" },
      { key: "profile", title: "내 기업 프로필", icon: "people" },
      { key: "privacy", title: "공개·동의 설정", icon: "lock" },
    ],
  },
  chapter: {
    name: "챕터 운영자",
    who: "가상 서울비즈 챕터 / 운영자",
    caption: "CHAPTER OPERATIONS",
    account: "운영자",
    nav: [
      { key: "home", title: "운영 대시보드", icon: "grid" },
      { key: "members", title: "회원·승인 대기", icon: "people" },
      { key: "meetings", title: "모임·출석 관리", icon: "calendar" },
      { key: "referrals", title: "소개·후속관리", icon: "link" },
      { key: "visitors", title: "방문자 관리", icon: "mail" },
      { key: "reports", title: "챕터 성과 분석", icon: "chart" },
    ],
  },
  tenant: {
    name: "기관 관리자",
    who: "가상 한국사업가연합 / 총괄",
    caption: "TENANT MANAGEMENT",
    account: "기관총괄",
    nav: [
      { key: "home", title: "기관 대시보드", icon: "grid" },
      { key: "chapters", title: "챕터 운영 현황", icon: "layers" },
      { key: "billing", title: "구독·청구", icon: "credit" },
      { key: "policies", title: "운영 정책·권한", icon: "shield" },
      { key: "branding", title: "브랜드 설정", icon: "settings" },
      { key: "insights", title: "기관 통합 성과", icon: "chart" },
    ],
  },
  platform: {
    name: "플랫폼 관리자",
    who: "LINKOS / 운영팀",
    caption: "PLATFORM OPERATIONS",
    account: "플랫폼 운영",
    nav: [
      { key: "home", title: "플랫폼 개요", icon: "grid" },
      { key: "tenants", title: "운영기관 계약 관리", icon: "building" },
      { key: "support", title: "지원·신고 티켓", icon: "message" },
      { key: "security", title: "보안·감사 이벤트", icon: "shield" },
      { key: "health", title: "서비스 상태", icon: "server" },
      { key: "releases", title: "배포 승인 현황", icon: "file" },
    ],
  },
};

export const DEFAULT_TENANT = "hankook";
export const DEFAULT_CHAPTER = "seoulbiz";

// Maps a role + page key to its /console route. Mirrors the documented Target_Route (prefix only differs).
export function routeFor(role: Role, page: string, tenant = DEFAULT_TENANT, chapter = DEFAULT_CHAPTER): string {
  const T = encodeURIComponent(tenant);
  const C = encodeURIComponent(chapter);
  const maps: Record<Role, Record<string, string>> = {
    member: {
      home: "/console/app",
      meetings: "/console/app/meetings",
      referrals: "/console/app/referrals",
      directory: "/console/app/directory",
      profile: "/console/app/company",
      privacy: "/console/app/settings/privacy",
    },
    chapter: {
      home: `/console/t/${T}/ch/${C}/dashboard`,
      members: `/console/t/${T}/ch/${C}/members`,
      meetings: `/console/t/${T}/ch/${C}/meetings`,
      referrals: `/console/t/${T}/ch/${C}/referrals`,
      visitors: `/console/t/${T}/ch/${C}/visitors`,
      reports: `/console/t/${T}/ch/${C}/reports`,
    },
    tenant: {
      home: `/console/t/${T}/dashboard`,
      chapters: `/console/t/${T}/chapters`,
      billing: `/console/t/${T}/billing`,
      policies: `/console/t/${T}/policies`,
      branding: `/console/t/${T}/branding`,
      insights: `/console/t/${T}/insights`,
    },
    platform: {
      home: "/console/p/admin",
      tenants: "/console/p/admin/tenants",
      support: "/console/p/admin/support",
      security: "/console/p/admin/security",
      health: "/console/p/admin/health",
      releases: "/console/p/admin/releases",
    },
  };
  return maps[role][page] ?? maps[role].home ?? "/console/app";
}

// The documented spec route (uiux/SCREEN_CATALOG.csv) shown as reference in the shell footer.
export function specRouteFor(role: Role, page: string): string {
  const specs: Record<Role, Record<string, string>> = {
    member: { home: "/app", meetings: "/app/meetings", referrals: "/app/referrals", directory: "/app/directory", profile: "/app/company", privacy: "/app/settings/privacy" },
    chapter: { home: "/t/:tenant/ch/:chapter/dashboard", members: "/t/:tenant/ch/:chapter/members", meetings: "/t/:tenant/ch/:chapter/meetings", referrals: "/t/:tenant/ch/:chapter/referrals", visitors: "/t/:tenant/ch/:chapter/visitors", reports: "/t/:tenant/ch/:chapter/reports" },
    tenant: { home: "/t/:tenant/dashboard", chapters: "/t/:tenant/chapters", billing: "/t/:tenant/billing", policies: "/t/:tenant/policies", branding: "/t/:tenant/branding", insights: "/t/:tenant/insights" },
    platform: { home: "/p/admin", tenants: "/p/admin/tenants", support: "/p/admin/support", security: "/p/admin/security", health: "/p/admin/health", releases: "/p/admin/releases" },
  };
  return specs[role]?.[page] ?? "";
}

export type Member = { id: number; name: string; industry: string; date: string; status: string };

export type Model = {
  period: string;
  search: string;
  introA: boolean;
  introB: boolean;
  consents: Record<string, boolean>;
  members: Member[];
  visitorStatus: string;
  meetingRsvp: boolean;
  followupDone: boolean;
};

export const initialModel = (): Model => ({
  period: "30",
  search: "",
  introA: false,
  introB: false,
  consents: { introduction: true, marketing: false, discovery: false },
  members: [
    { id: 1, name: "박서윤", industry: "마케팅", date: "10.21", status: "대기" },
    { id: 2, name: "정도현", industry: "제조업", date: "10.20", status: "대기" },
    { id: 3, name: "이하린", industry: "세무", date: "10.14", status: "승인" },
    { id: 4, name: "오지훈", industry: "소프트웨어", date: "10.10", status: "승인" },
  ],
  visitorStatus: "미발송",
  meetingRsvp: false,
  followupDone: false,
});

// [name, industry, offering, region, verification]
export const ORGS: string[][] = [
  ["가상AI랩", "IT·소프트웨어", "AI 품질검사 / ERP 연동", "서울", "서류 미확인"],
  ["가상그린산업", "제조업", "전기설비·금속가공 / 생산위탁", "인천", "자진신고"],
  ["가상브랜드스튜디오", "마케팅", "콘텐츠 제작 / 브랜딩 / 웹개발", "서울", "자진신고"],
  ["가상무역파트너", "유통업", "동남아 유통·현지화", "경기", "검토 중"],
  ["가상법률컨설팅", "전문서비스", "기업 계약 검토 / 자문", "서울", "자진신고"],
];
