// F-021 / F-036 — LINKOS line-icon bank (original glyphs).
// 24px grid · stroke 1.7 · round caps/joins — same drawing rules as apps/web/src/components/Icon.tsx.
// Generic glyphs only: no third-party brand logos or trade dress. Pure data (no I/O); NOT re-exported from the
// package index so it never ships on the guest landing — import "@linkos/domain/iconBank" explicitly.

export const ICON_CATEGORIES = ["contact", "social", "business", "industry", "objects", "arrows", "status", "nature", "korean"] as const;
export type IconCategory = (typeof ICON_CATEGORIES)[number];

export const ICON_CATEGORY_LABEL: Record<IconCategory, { ko: string; en: string }> = {
  contact: { ko: "연락", en: "Contact" },
  social: { ko: "소셜", en: "Social" },
  business: { ko: "비즈니스", en: "Business" },
  industry: { ko: "산업", en: "Industry" },
  objects: { ko: "사물", en: "Objects" },
  arrows: { ko: "화살표", en: "Arrows" },
  status: { ko: "상태", en: "Status" },
  nature: { ko: "자연·날씨", en: "Nature" },
  korean: { ko: "한국 모티프", en: "Korean motifs" },
};

export interface BankIcon {
  id: string;
  category: IconCategory;
  /** SVG path data on a 24×24 viewBox, drawn as a stroke (fill none). */
  d: string;
  en: string[];
  ko: string[];
}

// ── geometry helpers (deterministic path builders) ─────────────────────
const n = (v: number) => String(+v.toFixed(2));
/** full circle as two arcs */
const ci = (x: number, y: number, r: number) => `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
/** rectangle, optionally rounded */
const rc = (x: number, y: number, w: number, h: number, r = 0) =>
  r > 0
    ? `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(h - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(-(w - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}v${n(-(h - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
    : `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
const j = (...parts: string[]) => parts.join(" ");

type Row = [id: string, d: string, en: string, ko: string];

const CONTACT: Row[] = [
  ["phone", "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2", "phone call telephone", "전화 통화"],
  ["mobile", j(rc(7, 2, 10, 20, 2), "M11 18h2"), "mobile cell smartphone", "휴대폰 핸드폰 모바일"],
  ["mail", j(rc(3, 5, 18, 14, 2), "M3.5 6.5 12 13l8.5-6.5"), "mail email envelope", "메일 이메일 편지"],
  ["mail-open", "M3 10l9-6 9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M3 10l9 6 9-6", "mail open read", "메일 열림 읽음"],
  ["at", j(ci(12, 12, 4), "M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"), "at email handle", "골뱅이 이메일 아이디"],
  ["globe", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18", "web website globe internet", "웹사이트 홈페이지 지구 인터넷"],
  ["link", "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1", "link url chain", "링크 주소 연결"],
  ["pin", "M12 21s-7-6.2-7-11.5a7 7 0 1 1 14 0C19 14.8 12 21 12 21M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5", "location address pin place", "위치 주소 장소 핀"],
  ["map", "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15", "map directions", "지도 길찾기"],
  ["fax", "M7 9V3h10v6 M4 9h16v9H4z M7 14h4 M7 21h10v-3H7z", "fax printer office", "팩스 사무실"],
  ["chat", "M4 5h16v11H9l-5 4z", "chat message talk", "채팅 메시지 대화"],
  ["chat-dots", "M4 5h16v11H9l-5 4z M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01", "chat typing messenger", "메신저 대화중 채팅"],
  ["calendar", "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1", "calendar booking schedule meeting", "캘린더 예약 일정 미팅"],
  ["clock", j(ci(12, 12, 9), "M12 7v5l3 2"), "clock time hours", "시계 시간 영업시간"],
  ["user", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0", "user person profile", "사람 프로필 개인"],
  ["users", "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.87M15 3.13a3.5 3.5 0 0 1 0 6.75", "team people group", "팀 사람들 그룹"],
  ["id-card", j(rc(3, 5, 18, 14, 2), ci(8.5, 11, 2), "M5.5 16a3 3 0 0 1 6 0 M14 10h4 M14 14h3"), "id card badge identity", "신분증 사원증 아이디"],
  ["address-book", j("M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6z M4 7h2 M4 12h2 M4 17h2", ci(12.5, 10, 2), "M9.5 16a3 3 0 0 1 6 0"), "contacts address book", "연락처 주소록"],
  ["video-call", j(rc(3, 6, 12, 12, 2), "M15 10l6-3v10l-6-3"), "video call camera meeting", "화상통화 영상 미팅"],
  ["send", "M21 3 3 10.5l7 2.5 2.5 7z M10 13l11-10", "send paper plane", "보내기 전송"],
  ["inbox", "M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M3 13h5l1.5 2.5h5L16 13h5", "inbox tray receive", "받은편지함 수신"],
  ["voicemail", j(ci(6.5, 12, 3.5), ci(17.5, 12, 3.5), "M6.5 15.5h11"), "voicemail message", "음성메시지 음성사서함"],
  ["headset", "M4 15v-3a8 8 0 0 1 16 0v3 M4 15h3v5H5a1 1 0 0 1-1-1z M20 15h-3v5h2a1 1 0 0 0 1-1z M17 20c0 1-2 1.5-4 1.5", "support headset help desk", "고객지원 헤드셋 상담"],
  ["business-card", j(rc(2, 6, 20, 12, 2), "M6 10h6 M6 14h9 M17 10h1"), "business card namecard", "명함 카드"],
  ["location-arrow", "M3 11l18-8-8 18-2-8z", "navigate direction gps", "내위치 길안내 내비"],
];

const SOCIAL: Row[] = [
  ["heart", "M12 20.5C7 17 3 13.6 3 9.2A4.7 4.7 0 0 1 12 7a4.7 4.7 0 0 1 9 2.2c0 4.4-4 7.8-9 11.3z", "heart like love", "하트 좋아요 사랑"],
  ["thumbs-up", "M7 10v10H4V10z M7 10l4-7a2 2 0 0 1 2.5 2.4L12.5 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7", "thumbs up approve like", "추천 최고 좋아요"],
  ["share-nodes", j(ci(18, 5, 2.5), ci(6, 12, 2.5), ci(18, 19, 2.5), "M8.2 10.8l7.6-4.4 M8.2 13.2l7.6 4.4"), "share network", "공유 퍼가기"],
  ["hashtag", "M9 3 7 21 M17 3l-2 18 M4 8.5h17 M3 15.5h17", "hashtag tag topic", "해시태그 태그 주제"],
  ["play-circle", j(ci(12, 12, 9), "M10 8.5v7l6-3.5z"), "video play channel", "영상 재생 채널"],
  ["podcast", j(ci(12, 10, 2.5), "M12 13v8 M7.8 14.5a6 6 0 1 1 8.4 0 M5 17.2a9.5 9.5 0 1 1 14 0"), "podcast audio show", "팟캐스트 오디오 방송"],
  ["rss", "M5 19h.01 M5 11a8 8 0 0 1 8 8 M5 4a15 15 0 0 1 15 15", "rss feed blog", "피드 구독 블로그"],
  ["star", "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z", "star favorite rating", "별 즐겨찾기 평점"],
  ["bookmark", "M6 3h12v18l-6-4-6 4z", "bookmark save", "북마크 저장"],
  ["comment", "M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z", "comment reply bubble", "댓글 답글 말풍선"],
  ["repost", "M4 10V8a3 3 0 0 1 3-3h12l-3-3 M20 14v2a3 3 0 0 1-3 3H5l3 3", "repost share again", "리포스트 재공유"],
  ["megaphone", "M3 10v4h3l9 5V5L6 10z M6 14l1.5 6h2.5l-1-5.5 M18 9a4 4 0 0 1 0 6", "announce marketing promo", "공지 홍보 마케팅 확성기"],
  ["newsletter", j(rc(3, 4, 18, 16, 2), "M7 8h10 M7 12h4 M7 16h4 M14 12h3v4h-3z"), "newsletter article", "뉴스레터 아티클 소식"],
  ["blog-pen", "M4 20h16 M5 16l10-10 3 3-10 10H5z M13 8l3 3", "blog write post", "블로그 글쓰기 포스팅"],
  ["profile-circle", j(ci(12, 12, 9), ci(12, 10, 3), "M6.5 18.3a6 6 0 0 1 11 0"), "account profile avatar", "계정 프로필 아바타"],
  ["group-chat", "M3 4h12v8H7l-4 3z M9 15v1h8l4 3V8h-3", "group chat community", "단톡 커뮤니티 그룹채팅"],
  ["live", j(ci(12, 12, 2), "M7.8 7.8a6 6 0 0 0 0 8.4 M16.2 7.8a6 6 0 0 1 0 8.4 M5 5a10 10 0 0 0 0 14 M19 5a10 10 0 0 1 0 14"), "live stream broadcast", "라이브 생방송 스트리밍"],
  ["follow", j(ci(9, 8, 3.5), "M2.5 20a6.5 6.5 0 0 1 13 0 M19 8v6 M16 11h6"), "follow add connect", "팔로우 추가 연결"],
  ["network", j(ci(12, 5, 2), ci(5, 18, 2), ci(19, 18, 2), ci(12, 13, 2), "M12 7v4 M10.3 14l-3.6 2.8 M13.7 14l3.6 2.8"), "network graph connections", "네트워크 인맥 관계"],
  ["smile-chat", "M4 5h16v11H9l-5 4z M9 10.5a3.5 3.5 0 0 0 6 0", "friendly chat smile", "친근 대화 미소"],
];

const BUSINESS: Row[] = [
  ["briefcase", j(rc(3, 7, 18, 13, 2), "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M3 12.5h18"), "briefcase work job", "가방 업무 직장 서류가방"],
  ["building", "M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20", "building office company", "건물 사무실 회사"],
  ["chart-bar", "M4 20V10M10 20V4M16 20v-7M22 20H2", "chart bar stats", "차트 막대 통계"],
  ["chart-line", "M3 3v18h18 M7 15l4-4 3 3 6-7", "chart line growth analytics", "그래프 성장 분석"],
  ["chart-pie", "M12 3a9 9 0 1 0 9 9h-9z M15 2.5A7 7 0 0 1 21.5 9H15z", "pie chart share", "파이차트 점유율"],
  ["handshake", "M2 12l4-5 4 2 3-2 3 1 4 4 M2 12l3 3 M22 12l-4 4-5 3-3-2 M9 12l3 3 M11 10l4 4 M6 15l3 3", "handshake deal partner", "악수 계약 파트너 제휴"],
  ["target", j(ci(12, 12, 9), ci(12, 12, 5), ci(12, 12, 1)), "target goal focus", "목표 타깃 집중"],
  ["presentation", "M3 4h18 M4 4v11h16V4 M12 15v3 M8 21l4-3 4 3 M8 11l3-3 2 2 3-3", "presentation pitch slides", "발표 피칭 프레젠테이션"],
  ["document", "M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6", "document file paper", "문서 파일 서류"],
  ["folder", "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z", "folder portfolio", "폴더 포트폴리오"],
  ["clipboard", j(rc(5, 4, 14, 17, 2), rc(9, 2.5, 6, 3, 1), "M9 11h6 M9 15h4"), "clipboard checklist", "클립보드 체크리스트"],
  ["contract", "M6 3h12v18H6z M9 7h6 M9 11h6 M8.5 17c1-1.5 2-1.5 2.5 0s1.5 1 2.5-.5 2 .5 2 .5", "contract signature agreement", "계약서 서명 합의"],
  ["invoice", "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3", "invoice receipt bill", "청구서 영수증 견적"],
  ["coin", j(ci(12, 12, 9), "M14.5 9a2.5 2 0 0 0-5 0c0 3 5 1.5 5 4.5a2.5 2 0 0 1-5 0 M12 6v1.5 M12 16.5V18"), "coin money price", "동전 돈 가격"],
  ["wallet", "M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11v3 M16 13.5h.01", "wallet payment", "지갑 결제"],
  ["credit-card", "M3 6h18v12H3zM3 10h18M7 15h4", "credit card payment", "신용카드 결제"],
  ["bank", "M3 9 12 4l9 5 M4 9h16 M5 9v8 M9.5 9v8 M14.5 9v8 M19 9v8 M3 20h18", "bank finance institution", "은행 금융 기관"],
  ["shield-check", "M12 3l8 3v6c0 4.5-3.5 7.8-8 9-4.5-1.2-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5", "security trust insurance", "보안 신뢰 보험"],
  ["rocket", j("M14 4c3-1 5-1 6 0s1 3 0 6l-6 6-6-6z M8 10l-4 1 3-4h4 M14 16l-1 4 4-3v-4 M6 18c-1 0-2 1-2 2 1 0 2-1 2-2z", ci(15, 9, 1.5)), "rocket startup launch", "로켓 스타트업 출시"],
  ["lightbulb", "M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z", "idea insight innovation", "아이디어 인사이트 혁신"],
  ["puzzle", "M4 7h4.5a2 2 0 1 1 3 0H16v4.5a2 2 0 1 1 0 3V19H4z", "puzzle solution integration", "퍼즐 솔루션 통합"],
  ["gear", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1", "settings operations gear", "설정 운영 톱니"],
  ["org-chart", j(rc(9, 3, 6, 4, 1), rc(3, 17, 6, 4, 1), rc(15, 17, 6, 4, 1), "M12 7v5 M6 17v-3h12v3"), "organization hierarchy structure", "조직도 구조 계층"],
  ["trophy", "M8 4h8v5a4 4 0 0 1-8 0z M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4 M12 13v4 M8 21h8 M9.5 17h5v4", "trophy award winner", "트로피 수상 우승"],
  ["medal", j(ci(12, 15, 5), "M8.5 11 6 3h4l2 5 2-5h4l-2.5 8 M12 13v4"), "medal achievement", "메달 성과 업적"],
  ["badge-star", "M12 2.5l2.3 2 3-.4.9 2.9 2.7 1.4-1 2.8 1 2.8-2.7 1.4-.9 2.9-3-.4-2.3 2-2.3-2-3 .4-.9-2.9L3.1 14l1-2.8-1-2.8 2.7-1.4.9-2.9 3 .4z M12 8l1.2 2.4 2.6.4-1.9 1.8.5 2.6L12 14l-2.4 1.2.5-2.6-1.9-1.8 2.6-.4z", "badge quality certified", "배지 품질 인증"],
  ["key", j(ci(8, 15, 4), "M11 12l9-9 M17 6l3 3 M15 8l2 2"), "key access solution", "열쇠 키 접근"],
  ["seal-stamp", "M9 4h6v4a3 3 0 0 1-1 2h-4a3 3 0 0 1-1-2z M10 10l-1 5h6l-1-5 M4 15h16v3H4z M6 21h12", "stamp approval official", "도장 승인 결재"],
  ["calculator", j(rc(5, 3, 14, 18, 2), rc(8, 6, 8, 4, 0.5), "M8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01"), "calculator accounting tax", "계산기 회계 세무"],
  ["stock-up", "M3 17l6-6 4 4 8-8 M15 7h6v6", "stocks investment growth", "주식 투자 상승"],
  ["percent", j("M19 5 5 19", ci(7, 7, 2.5), ci(17, 17, 2.5)), "percent discount rate", "퍼센트 할인 이율"],
  ["scale", "M12 3v18 M7 21h10 M5 7h14 M5 7 2 14h6z M2 14a3 3 0 0 0 6 0 M19 7l-3 7h6z M16 14a3 3 0 0 0 6 0", "law justice balance legal", "법률 정의 저울 변호사"],
  ["gavel", "M14 4l6 6 M11 7l6 6 M12.5 5.5l-4 4 3 3 4-4 M10 11l-7 7 2 2 7-7 M13 21h8", "gavel court judge", "판사 법원 의사봉"],
];

const INDUSTRY: Row[] = [
  ["piggy-bank", "M19 10c1 0 2 .5 2 2v1h-2a6 6 0 0 1-2 3v3h-3v-2h-4v2H7v-3a6 6 0 0 1 2-11h4a6 6 0 0 1 4 1.5l2-1.5v3 M15 10h.01 M10 6.5h3", "savings piggy bank finance", "저축 돼지저금통 재테크"],
  ["book-law", "M5 4h11a3 3 0 0 1 3 3v14H8a3 3 0 0 1-3-3z M5 18a3 3 0 0 1 3-3h11 M10 8h5", "law book statute", "법전 법률서 규정"],
  ["stethoscope", j("M6 3v6a4 4 0 0 0 8 0V3 M5 3h2 M13 3h2 M10 13v2a5 5 0 0 0 10 0v-2", ci(20, 11, 2)), "doctor medical stethoscope", "의사 진료 청진기"],
  ["pill", "M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7z M7 7l7 7", "pharmacy medicine pill", "약국 약 제약"],
  ["medical-cross", "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z", "medical health clinic", "의료 건강 병원"],
  ["heartbeat", "M3 12h4l2-5 4 10 2-5h6", "heartbeat vital health", "심박 바이탈 헬스케어"],
  ["tooth", "M7 3c-2.5 0-4 2-4 4.5 0 3 1.5 5 2 8 .5 3 1 5.5 2.5 5.5S9 16 12 16s3 5 4.5 5 2-2.5 2.5-5.5c.5-3 2-5 2-8C21 5 19.5 3 17 3c-2 0-3 1-5 1S9 3 7 3z", "dental dentist tooth", "치과 치아"],
  ["syringe", "M19 2l3 3 M20.5 3.5 17 7 M15 3l6 6 M18 6 8 16H5v-3L15 3 M5 16l-3 3 M10 9l2 2 M7.5 11.5l2 2", "vaccine injection syringe", "주사 백신"],
  ["hospital", "M4 21V7h16v14 M2 21h20 M12 9v6 M9 12h6 M9 21v-3h6v3 M8 7V3h8v4", "hospital clinic", "병원 의원"],
  ["dna", "M7 3c0 6 10 6 10 12s-10 6-10 6 M17 3c0 6-10 6-10 12 M9 6h6 M8 9.5h8 M8 14.5h8 M9 18h6", "dna bio genetics", "바이오 유전자 생명과학"],
  ["code", "M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16", "code developer software", "코드 개발자 소프트웨어"],
  ["cpu", j(rc(6, 6, 12, 12, 2), rc(9.5, 9.5, 5, 5), "M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"), "chip semiconductor hardware", "반도체 칩 하드웨어"],
  ["cloud-up", "M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9 M12 12v7 M9 15l3-3 3 3", "cloud saas upload", "클라우드 SaaS 업로드"],
  ["database", "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3", "database data storage", "데이터베이스 데이터 저장소"],
  ["server", j(rc(3, 4, 18, 7, 2), rc(3, 13, 18, 7, 2), "M7 7.5h.01 M7 16.5h.01 M11 7.5h6 M11 16.5h6"), "server infrastructure hosting", "서버 인프라 호스팅"],
  ["terminal", j(rc(2, 4, 20, 16, 2), "M6 9l3 3-3 3 M12 15h6"), "terminal console devops", "터미널 콘솔 데브옵스"],
  ["wifi", "M2 9a15 15 0 0 1 20 0 M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01", "wifi wireless network", "와이파이 무선 통신"],
  ["robot", j(rc(4, 8, 16, 12, 3), ci(12, 3, 1), "M12 4v4 M9 13h.01 M15 13h.01 M9 17h6 M2 13v3 M22 13v3"), "robot automation ai", "로봇 자동화 인공지능"],
  ["circuit", j("M4 12h5l2-4h6 M11 16h9 M4 4v4h5 M20 8v4h-3", ci(19, 8, 1.5), ci(4, 12, 1.5)), "circuit electronics iot", "회로 전자 IoT"],
  ["ai-sparkle", "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z", "ai magic generative", "AI 인공지능 생성"],
  ["app-grid", j(rc(6, 2, 12, 20, 2), rc(9, 6, 2.5, 2.5, 0.5), rc(12.5, 6, 2.5, 2.5, 0.5), rc(9, 9.5, 2.5, 2.5, 0.5), rc(12.5, 9.5, 2.5, 2.5, 0.5)), "app mobile product", "앱 모바일 제품"],
  ["pen-nib", j("M5 13l3-9h8l3 9-7 8z M12 4v7", ci(12, 12.5, 1.5)), "design pen nib illustration", "디자인 펜촉 일러스트"],
  ["palette", "M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5z M7.5 11h.01M10 7h.01M15 7.5h.01", "palette color art", "팔레트 색상 미술"],
  ["set-square", "M4 20V4l16 16z M8 16h3l-3-3z M4 8h2 M4 12h2", "set square drafting", "삼각자 제도"],
  ["layers", "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5", "layers stack design", "레이어 디자인 스택"],
  ["crop", "M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14", "crop photo edit", "자르기 사진 편집"],
  ["paint-brush", "M20 3c-4 2-8 6-10 9l2 2c3-2 7-6 9-10z M9 13c-2 0-4 1.5-4 4 0 1.5-1 2.5-2 3 3 1 7 0 8-3z", "paint brush creative", "붓 페인트 크리에이티브"],
  ["bezier", j(rc(3, 3, 4, 4), rc(17, 17, 4, 4), "M7 5c7 0 12 5 12 12 M7 5h6 M19 17v-6"), "vector bezier curve", "벡터 베지어 곡선"],
  ["type", "M4 7V5h16v2 M12 5v14 M9 19h6", "typography font text", "타이포 글꼴 텍스트"],
  ["coffee", "M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z M17 10h1.5a2.5 2.5 0 0 1 0 5H17 M8 3c-.5 1 .5 2 0 3 M12 3c-.5 1 .5 2 0 3", "coffee cafe", "커피 카페"],
  ["fork-knife", "M6 3v8 M4 3v5a2 2 0 0 0 4 0V3 M6 11v10 M17 3c-2 2-2 6 0 8 M17 3v18", "restaurant food dining", "레스토랑 음식 식당"],
  ["chef-hat", "M7 14v6h10v-6 M7 14a4 4 0 0 1-1-7.8A4.5 4.5 0 0 1 12 4a4.5 4.5 0 0 1 6 2.2A4 4 0 0 1 17 14z M7 17h10", "chef cook kitchen", "셰프 요리 주방"],
  ["wine", "M8 3h8c0 5 0 8-4 9-4-1-4-4-4-9z M12 12v8 M8 21h8 M8 7h8", "wine bar sommelier", "와인 바 소믈리에"],
  ["bread", "M5 11a3 3 0 0 1 0-6h14a3 3 0 0 1 0 6v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z M9 11v3 M13 11v3", "bakery bread", "베이커리 빵"],
  ["rice-bowl", "M3 12h18a9 9 0 0 1-18 0z M7 12c0-3 2-5 5-5s5 2 5 5 M9 21h6", "rice bowl meal korean food", "밥 공기 한식 식사"],
  ["plane", "M21.5 12c0-1-1-1.8-2.5-1.8h-4.5L9.5 3h-2l2.4 7.2H5.5L4 8H2.5l1 4-1 4H4l1.5-2.2h4.4L7.5 21h2l5-7.2H19c1.5 0 2.5-.8 2.5-1.8z", "flight travel airline", "비행기 여행 항공"],
  ["suitcase", j(rc(4, 7, 16, 13, 2), "M9 7V4h6v3 M8 11v5 M16 11v5 M7 20v1.5 M17 20v1.5"), "luggage trip business travel", "캐리어 출장 여행"],
  ["compass", j(ci(12, 12, 9), "M15.5 8.5l-2 5-5 2 2-5z"), "compass explore direction", "나침반 탐험 방향"],
  ["hotel-bed", j("M3 6v14 M3 16h18v4 M21 16v-3a3 3 0 0 0-3-3h-8v6", ci(6.5, 12.5, 1.5)), "hotel stay hospitality", "호텔 숙박 호스피탈리티"],
  ["ticket", "M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z M14 7v10", "ticket event pass", "티켓 이벤트 입장권"],
  ["passport", j(rc(5, 3, 14, 18, 2), ci(12, 10, 3), "M9 16h6"), "passport global visa", "여권 해외 비자"],
  ["grad-cap", "M2 9l10-5 10 5-10 5z M6 11v5c3 2 9 2 12 0v-5 M22 9v6", "education graduate university", "교육 졸업 대학"],
  ["book-open", "M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z", "book reading publishing", "책 독서 출판"],
  ["pencil", "M4 20l1-5L16 4l4 4L9 19z M14 6l4 4 M4 20l5-1", "pencil write edit", "연필 작성 수정"],
  ["atom", j(ci(12, 12, 1.5), "M3 12a9 3.5 0 1 0 18 0a9 3.5 0 1 0-18 0 M7.5 4.21a9 3.5 60 1 0 9 15.59a9 3.5 60 1 0-9-15.59 M7.5 19.79a9 3.5 -60 1 0 9-15.59a9 3.5 -60 1 0-9 15.59"), "science research physics", "과학 연구 물리"],
  ["chalkboard", j(rc(3, 4, 18, 12, 1), "M7 20l2-4 M17 20l-2-4 M7 8h6 M7 11h4"), "teaching class lecture", "강의 수업 칠판"],
  ["backpack", "M6 8a6 6 0 0 1 12 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z M9 3.5h6 M9 14h6v4H9z", "student school backpack", "학생 학교 백팩"],
  ["house-key", j("M3 11l9-7 9 7 M5 10v10h6", ci(16, 16, 2.5), "M17.8 17.8l3.2 3.2 M20 20l1-1"), "real estate home key", "부동산 집 열쇠"],
  ["floor-plan", j(rc(3, 3, 18, 18, 1), "M3 12h7 M10 3v6 M14 12h7 M14 12v4 M10 16v5"), "floor plan interior", "평면도 인테리어"],
  ["tower-crane", "M6 21V3 M3 21h8 M6 3h14 M6 7l4-4 M16 3v7 M14 10h4v3h-4z", "construction crane build", "건설 크레인 시공"],
  ["door", "M6 21V3h12v18 M3 21h18 M14 12h.01", "door entrance property", "문 출입 매물"],
  ["skyline", "M3 21V11h4V6h4v15 M11 21V3h6v18 M17 21v-9h4v9 M2 21h20 M14 7h.01M14 11h.01M14 15h.01", "city skyline urban", "도시 스카이라인 빌딩"],
  ["factory", "M3 21V10l6 4v-4l6 4V5h4v16z M2 21h20 M7 17h2 M12 17h2", "factory manufacturing plant", "공장 제조 생산"],
  ["wrench", "M15 3a5 5 0 0 0-4.6 7L3 17.4V21h3.6l7.4-7.4A5 5 0 0 0 21 9l-3 3-3-3 3-3a5 5 0 0 0-3-3z", "repair maintenance service", "수리 정비 서비스"],
  ["hammer", "M13 7l4 4 M3 20l9.5-9.5 M11 5l3-2h3l4 4v2l-2 2-4-4-2 2z", "build craft hammer", "망치 공예 시공"],
  ["hard-hat", "M2 18h20 M4 18v-3a8 8 0 0 1 16 0v3 M10 7V5h4v2 M12 7v5", "safety engineer construction", "안전모 엔지니어 현장"],
  ["package", "M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10 M7.5 5l9 4", "package product shipping", "택배 제품 배송"],
  ["cogs", j(ci(9, 9, 3), ci(17, 16, 2.5), "M9 3v2M9 13v2M3 9h2M13 9h2M4.8 4.8l1.4 1.4M11.8 11.8l1.4 1.4M4.8 13.2l1.4-1.4M11.8 6.2l1.4-1.4 M17 11.5v2M17 18.5v2M12.5 16h2M19.5 16h2"), "engineering machinery process", "기계 공정 엔지니어링"],
  ["truck", j("M2 6h12v11H2z M14 10h4l3 3v4h-2 M9 17h6", ci(6, 18, 2), ci(17, 18, 2)), "logistics delivery truck", "물류 배송 트럭"],
  ["ship", "M3 15l2 5h14l2-5z M5 15V9h14v6 M12 9V4 M9 4h6", "shipping maritime trade", "해운 무역 선박"],
  ["solar-panel", "M4 4h16l2 10H2z M3 9h18 M9 4l-1 10 M15 4l1 10 M12 14v4 M8 21h8", "solar energy renewable", "태양광 에너지 신재생"],
  ["wind-turbine", j("M12 10v11 M9 21h6 M12 10V2.5 M12 10l6.5 3.75 M12 10l-6.5 3.75", ci(12, 10, 1.2)), "wind power turbine", "풍력 발전 터빈"],
  ["battery", j(rc(2, 7, 17, 10, 2), "M22 11v2 M6 10v4 M10 10v4"), "battery storage ev", "배터리 저장 전기차"],
  ["plug", "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4", "plug power electric", "플러그 전력 전기"],
  ["bolt", "M13 2 4 14h7l-1 8 9-12h-7z", "energy power bolt fast", "에너지 전기 번개 빠름"],
  ["leaf", "M5 19C5 10 10 5 20 4c-1 10-6 15-15 15z M5 19l8-8", "eco green sustainability", "친환경 그린 지속가능"],
  ["recycle", "M7 19H4.5a1.5 1.5 0 0 1-1.3-2.2L6 12 M10 6.5l1-1.7a1.5 1.5 0 0 1 2.6 0L16.5 9 M17 15l2 3.3A1.5 1.5 0 0 1 17.7 20H12 M6 12l-3 .5 M6 12l1 2.8 M16.5 9l.6-3 M16.5 9l-2.9.7 M12 20l2-2 M12 20l2 2", "recycle circular esg", "재활용 순환 ESG"],
  ["film", "M3 3h18v18H3z M7 3v18 M17 3v18 M3 8h4 M3 12h4 M3 16h4 M17 8h4 M17 12h4 M17 16h4", "film movie cinema", "영화 필름 시네마"],
  ["clapper", "M3 10h18v10H3z M3 10l1-5 16-3 1 5 M8 4.5l2 4.5 M13 3.5l2 4.8", "production video shoot", "촬영 영상 제작"],
  ["studio-mic", j(rc(9, 2, 6, 11, 3), "M5 10a7 7 0 0 0 14 0 M12 17v4 M8 21h8"), "microphone voice speaker", "마이크 음성 연사"],
  ["headphones", "M3 18v-6a9 9 0 0 1 18 0v6 M3 15h4v6H4a1 1 0 0 1-1-1z M21 15h-4v6h3a1 1 0 0 0 1-1z", "music audio sound", "헤드폰 음악 사운드"],
  ["broadcast", j(ci(12, 12, 1.5), "M12 13.5V21 M9 21h6 M8.5 8.5a5 5 0 0 0 0 7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 5.6a9 9 0 0 0 0 12.8 M18.4 5.6a9 9 0 0 1 0 12.8"), "broadcast radio tower", "방송 라디오 송출"],
  ["newspaper", "M4 4h13v16H6a2 2 0 0 1-2-2z M17 8h3v10a2 2 0 0 1-4 0 M7 8h7 M7 12h7 M7 16h4", "news press journalism", "뉴스 언론 기자"],
  ["sprout", "M12 21v-9 M12 12C12 8 9 6 4 6c0 4 3 6 8 6z M12 14c0-4 3-6 8-6 0 4-3 6-8 6z", "agriculture farm growth", "농업 농장 새싹"],
  ["car", "M3 16v-4l2-5h14l2 5v4z M3 16v3h3v-3 M18 16v3h3v-3 M3 12h18 M7 14h.01 M17 14h.01", "car automotive mobility", "자동차 모빌리티"],
  ["dumbbell", "M6 7v10 M18 7v10 M3 9v6 M21 9v6 M6 12h12", "fitness gym training", "피트니스 헬스 운동"],
  ["music-note", j("M9 18V5l11-2v13", ci(6, 18, 3), ci(17, 16, 3)), "music artist song", "음악 아티스트 노래"],
  ["paw", j(ci(12, 16, 3.5), ci(6, 10, 1.8), ci(9.5, 6, 1.8), ci(14.5, 6, 1.8), ci(18, 10, 1.8)), "pet vet animal", "반려동물 수의 동물"],
  ["scissors", j(ci(6, 6, 3), ci(6, 18, 3), "M8.6 7.5 20 18 M8.6 16.5 20 6"), "salon beauty hair cut", "미용 헤어 가위"],
  ["ball", j(ci(12, 12, 9), "M12 3v4l-4 3 1.5 4.5h5L16 10l-4-3 M8 10l-4.5-1 M16 10l4.5-1 M9.5 14.5l-2 4.5 M14.5 14.5l2 4.5"), "sports soccer ball", "스포츠 축구 공"],
  ["shopping-bag", "M5 8h14l-1 13H6z M9 8V6a3 3 0 0 1 6 0v2", "shopping retail commerce", "쇼핑 리테일 커머스"],
  ["store", "M3 9l2-5h14l2 5 M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 M5 12v9h14v-9 M10 21v-5h4v5", "store shop retail", "매장 가게 상점"],
  ["gem", "M6 3h12l4 6-10 12L2 9z M2 9h20 M8 9l4 12 4-12 M9 3 8 9 M15 3l1 6", "jewelry luxury gem", "보석 주얼리 럭셔리"],
];

const OBJECTS: Row[] = [
  ["pen", "M3 21l3-1 12-12-2-2L4 18z M14 6l2 2 M15 3l6 6-2 2", "pen sign write", "펜 서명 쓰기"],
  ["notebook", j(rc(5, 3, 14, 18, 2), "M9 3v18 M12 8h4 M12 12h4"), "notebook notes", "노트 메모"],
  ["gift", j(rc(3, 8, 18, 4, 1), "M5 12v9h14v-9 M12 8v13 M12 8C10 4 6.5 4.5 7.5 7c.5 1 2.5 1 4.5 1 M12 8c2-4 5.5-3.5 4.5-1-.5 1-2.5 1-4.5 1"), "gift present benefit", "선물 혜택"],
  ["glasses", j(ci(6.5, 14, 3.5), ci(17.5, 14, 3.5), "M10 14h4 M3 13l2-6 M21 13l-2-6"), "glasses optical vision", "안경 안경원 시력"],
  ["watch", j(ci(12, 12, 6), "M12 9v3l2 1 M9 6l1-4h4l1 4 M9 18l1 4h4l1-4"), "watch time punctual", "손목시계 시간"],
  ["umbrella", "M3 12a9 9 0 0 1 18 0z M12 12v7a2 2 0 0 1-4 0", "umbrella cover insurance", "우산 보장 보험"],
  ["lamp", "M8 3h8l3 8H5z M12 11v8 M8 21h8", "lamp interior lighting", "조명 램프 인테리어"],
  ["mug", "M5 7h11v11a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z M16 10h2a2 2 0 0 1 0 4h-2", "mug tea break", "머그 차 휴식"],
  ["camera", "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "camera photo photographer", "카메라 사진 포토그래퍼"],
  ["laptop", j(rc(4, 5, 16, 11, 1), "M2 19h20"), "laptop computer work", "노트북 컴퓨터 업무"],
  ["monitor", j(rc(3, 4, 18, 12, 2), "M8 21h8 M12 16v5"), "monitor desktop screen", "모니터 데스크톱 화면"],
  ["tablet", j(rc(5, 3, 14, 18, 2), "M11 18h2"), "tablet device", "태블릿 기기"],
  ["printer", "M6 9V3h12v6 M6 18H4v-8a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v8h-2 M6 14h12v7H6z", "printer print", "프린터 인쇄"],
  ["mouse", j(rc(6, 3, 12, 18, 6), "M12 7v4"), "mouse click", "마우스 클릭"],
  ["lock", "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4", "lock private secure", "자물쇠 비공개 보안"],
  ["unlock", "M6 11h12v10H6z M8 11V7a4 4 0 0 1 7.5-2", "unlock open access", "잠금해제 공개 접근"],
  ["bell", "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4", "bell notification alert", "알림 벨"],
  ["tag", "M3 3h8l10 10-8 8L3 11z M7.5 7.5h.01", "tag label price", "태그 라벨 가격표"],
  ["flag", "M5 21V4M5 4h11l-2 4 2 4H5", "flag milestone goal", "깃발 마일스톤 목표"],
  ["pushpin", "M9 3h6 M10 3v6l-3 4h10l-3-4V3 M12 13v8", "pin pushpin important", "고정 압정 중요"],
  ["paperclip", "M20 11l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17a2 2 0 0 1-3-3l7.5-7.5", "attachment clip file", "첨부 클립 파일"],
  ["magnet", "M5 3h4v8a3 3 0 0 0 6 0V3h4v8a7 7 0 0 1-14 0z M5 7h4 M15 7h4", "magnet attract lead", "자석 끌어당김 리드"],
  ["hourglass", "M6 3h12 M6 21h12 M7 3c0 5 10 5 10 9s-10 4-10 9 M17 3c0 5-10 5-10 9s10 4 10 9", "hourglass wait deadline", "모래시계 대기 마감"],
  ["anchor", j(ci(12, 5, 2), "M12 7v14 M8 11h8 M4 13a8 8 0 0 0 16 0 M4 13l-1.5 2 M20 13l1.5 2"), "anchor marine stable", "닻 해양 안정"],
  ["cube", "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9", "cube 3d product", "큐브 3D 제품"],
  ["archive", j(rc(3, 4, 18, 4, 1), "M5 8v12h14V8 M10 12h4"), "archive box storage", "보관 아카이브 상자"],
  ["compass-drafting", j(ci(12, 5, 2), "M11 7 5 21 M13 7l6 14 M7 15h10"), "drafting compass architect", "컴퍼스 제도 설계"],
  ["candle", "M10 9h4v12h-4z M12 9V7 M12 2c-1 1.5-1.5 2.5 0 4 1.5-1.5 1-2.5 0-4z", "candle calm wellness", "캔들 힐링 웰니스"],
  ["telescope", "M3 13l14-6 2 4-14 6z M12 15l-2 6 M12 15l3 6 M17 7l1-3 3 1-1 3", "telescope vision future", "망원경 비전 미래"],
  ["ruler", "M3 17 17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2", "ruler measure", "자 측정"],
];

const ARROWS: Row[] = [
  ["arrow-right", "M5 12h14M13 6l6 6-6 6", "arrow right next", "오른쪽 다음 화살표"],
  ["arrow-left", "M19 12H5M11 6l-6 6 6 6", "arrow left back", "왼쪽 이전 화살표"],
  ["arrow-up", "M12 19V5M6 11l6-6 6 6", "arrow up", "위쪽 화살표"],
  ["arrow-down", "M12 5v14M6 13l6 6 6-6", "arrow down", "아래쪽 화살표"],
  ["arrow-up-right", "M7 17 17 7M8 7h9v9", "arrow diagonal open", "대각선 바로가기"],
  ["arrow-down-right", "M7 7l10 10M17 8v9H8", "arrow diagonal down", "대각선 아래"],
  ["chevron-right", "M9 5l7 7-7 7", "chevron right more", "꺾쇠 오른쪽 더보기"],
  ["chevron-left", "M15 5l-7 7 7 7", "chevron left", "꺾쇠 왼쪽"],
  ["chevron-up", "M5 15l7-7 7 7", "chevron up collapse", "꺾쇠 위 접기"],
  ["chevron-down", "M5 9l7 7 7-7", "chevron down expand", "꺾쇠 아래 펼치기"],
  ["chevrons-right", "M5 6l6 6-6 6M13 6l6 6-6 6", "fast forward skip", "빨리감기 건너뛰기"],
  ["refresh", "M20 11a8 8 0 0 0-14.5-4.5L3 9 M3 4v5h5 M4 13a8 8 0 0 0 14.5 4.5L21 15 M21 20v-5h-5", "refresh sync update", "새로고침 동기화 업데이트"],
  ["undo", "M9 14l-5-5 5-5 M4 9h10a6 6 0 0 1 0 12h-3", "undo revert", "실행취소 되돌리기"],
  ["redo", "M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3", "redo repeat", "다시실행"],
  ["expand", "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5", "expand fullscreen", "확대 전체화면"],
  ["shrink", "M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5", "shrink minimize", "축소 최소화"],
  ["swap-h", "M4 8h16l-4-4 M20 16H4l4 4", "swap exchange trade", "교환 맞바꿈 스왑"],
  ["swap-v", "M8 20V4L4 8 M16 4v16l4-4", "sort swap vertical", "정렬 상하교환"],
  ["external", "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5", "external link open", "외부링크 새창"],
  ["download-tray", "M12 3v12M7 10l5 5 5-5M4 17v3h16v-3", "download save", "다운로드 저장"],
  ["upload-tray", "M12 15V3M7 8l5-5 5 5M4 17v3h16v-3", "upload share", "업로드 올리기"],
  ["return", "M20 5v7a3 3 0 0 1-3 3H5 M9 11l-4 4 4 4", "return enter reply", "돌아가기 엔터 회신"],
  ["trend-down", "M3 7l6 6 4-4 8 8 M15 17h6v-6", "decline decrease cost down", "하락 감소 비용절감"],
  ["move", "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3", "move drag all directions", "이동 드래그 사방"],
  ["rotate", "M20 12a8 8 0 1 1-2.3-5.7L20 8.5 M20 3v5.5h-5.5", "rotate cycle repeat", "회전 순환 반복"],
  ["corner-down-right", "M5 4v8a4 4 0 0 0 4 4h10 M15 12l4 4-4 4", "corner forward route", "꺾인화살표 전달 경로"],
];

const STATUS: Row[] = [
  ["check", "M5 12.5l4.5 4.5L19 7.5", "check done ok", "체크 완료 확인"],
  ["check-circle", j(ci(12, 12, 9), "M8 12.5l3 3 5-6"), "success verified done", "성공 완료 확인됨"],
  ["x-circle", j(ci(12, 12, 9), "M9 9l6 6M15 9l-6 6"), "error cancel close", "오류 취소 닫기"],
  ["alert-triangle", "M12 3 2 20h20z M12 10v4 M12 17h.01", "warning caution alert", "경고 주의"],
  ["info", j(ci(12, 12, 9), "M12 11v5 M12 8h.01"), "info about", "정보 안내"],
  ["question", j(ci(12, 12, 9), "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14 M12 17h.01"), "help question faq", "도움말 질문 FAQ"],
  ["plus-circle", j(ci(12, 12, 9), "M12 8v8M8 12h8"), "add new create", "추가 새로만들기"],
  ["minus-circle", j(ci(12, 12, 9), "M8 12h8"), "remove minus", "빼기 제거"],
  ["pending", j(ci(12, 12, 9), "M8 12h.01M12 12h.01M16 12h.01"), "pending waiting in progress", "대기 진행중 보류"],
  ["eye", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "visible view public", "보기 공개 표시"],
  ["eye-off", "M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.4 M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2", "hidden private invisible", "숨김 비공개"],
  ["bell-dot", j("M6 16v-5a6 6 0 0 1 9-5.2 M18 11v5l2 2H4 M10 21h4", ci(18, 5.5, 2.5)), "new notification unread", "새알림 안읽음"],
  ["verified", "M12 2l2.4 1.8 3-.2.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .2z M8.5 12l2.5 2.5 4.5-5", "verified official authentic", "인증됨 공식 정품"],
  ["sparkle", "M12 3c.5 4.5 4.5 8.5 9 9-4.5.5-8.5 4.5-9 9-.5-4.5-4.5-8.5-9-9 4.5-.5 8.5-4.5 9-9z", "sparkle new highlight", "반짝 신규 하이라이트"],
  ["flame", "M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-3 5-3 8a6 6 0 0 0 6 6z", "hot trending popular", "인기 트렌드 핫"],
  ["signal", "M4 20v-3M9 20v-7M14 20V9M19 20V4", "signal strength level", "신호 강도 레벨"],
  ["battery-full", j(rc(2, 7, 17, 10, 2), "M22 11v2 M5.5 10v4 M8.5 10v4 M11.5 10v4 M14.5 10v4"), "full charged ready", "충전완료 준비완료"],
  ["toggle-on", j(rc(2, 7, 20, 10, 5), ci(16, 12, 3)), "toggle switch enabled", "토글 스위치 켜짐"],
  ["power", "M12 3v9 M6.3 6.3a8 8 0 1 0 11.4 0", "power on off", "전원 켜기 끄기"],
  ["ban", j(ci(12, 12, 9), "M5.6 5.6l12.8 12.8"), "blocked forbidden no", "차단 금지"],
  ["timer", j(ci(12, 13, 8), "M12 9v4l2.5 2.5 M10 2h4 M12 2v3"), "timer stopwatch quick", "타이머 스톱워치 빠른"],
  ["shield-alert", "M12 3l8 3v6c0 4.5-3.5 7.8-8 9-4.5-1.2-8-4.5-8-9V6z M12 8v5 M12 16h.01", "risk security alert", "위험 보안 경보"],
  ["thumbs-down", "M17 14V4h3v10z M17 14l-4 7a2 2 0 0 1-2.5-2.4L11.5 15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17", "dislike reject", "싫어요 거절"],
  ["online-dot", j(ci(12, 12, 4), ci(12, 12, 9)), "online available active", "온라인 가능 활성"],
  ["progress-half", j(ci(12, 12, 9), "M12 3v18 M12 7h4 M12 12h5 M12 17h4"), "progress half partial", "진행률 절반 진행중"],
];

const NATURE: Row[] = [
  ["sun", j(ci(12, 12, 4), "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"), "sun sunny day", "해 맑음 낮"],
  ["moon", "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z", "moon night", "달 밤"],
  ["cloud", "M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z", "cloud weather", "구름 날씨"],
  ["cloud-rain", "M7 15a5 5 0 0 1-.5-10A6 6 0 0 1 18 6a4.5 4.5 0 0 1-.5 9z M8 18l-1 3 M12 18l-1 3 M16 18l-1 3", "rain weather", "비 날씨"],
  ["snow", "M12 2v20 M3.3 7l17.4 10 M3.3 17 20.7 7 M9 4l3 2 3-2 M9 20l3-2 3 2", "snow winter cold", "눈 겨울 추위"],
  ["wind", "M3 8h11a3 3 0 1 0-3-3 M3 12h16a3 3 0 1 1-3 3 M3 16h7", "wind breeze air", "바람 공기"],
  ["rainbow", "M2 18a10 10 0 0 1 20 0 M6 18a6 6 0 0 1 12 0 M10 18a2 2 0 0 1 4 0", "rainbow diversity hope", "무지개 다양성 희망"],
  ["mountain", "M2 20 9 7l4 7 3-4 6 10z", "mountain outdoor peak", "산 아웃도어 정상"],
  ["wave", "M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2 M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2", "wave sea ocean water", "파도 바다 물결"],
  ["tree", "M12 22v-6 M12 3l6 8h-3l4 5H5l4-5H6z", "tree forest nature", "나무 숲 자연"],
  ["flower", j(ci(12, 6.5, 3), ci(12, 17.5, 3), ci(6.5, 12, 3), ci(17.5, 12, 3), ci(12, 12, 1.5)), "flower bloom florist", "꽃 개화 플로리스트"],
  ["cactus", "M10 21V5a2 2 0 0 1 4 0v16 M10 13H8a2 2 0 0 1-2-2V8 M14 11h2a2 2 0 0 0 2-2V6 M7 21h10", "cactus plant desert", "선인장 식물 사막"],
  ["drop", "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z", "water drop clean", "물방울 물 깨끗"],
  ["stars", "M12 3l1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5z M18 15l.8 1.7 1.7.8-1.7.8L18 20l-.8-1.7-1.7-.8 1.7-.8z M6 16l.6 1.4L8 18l-1.4.6L6 20l-.6-1.4L4 18l1.4-.6z", "stars night dream", "별 밤하늘 꿈"],
  ["planet", j(ci(12, 12, 6), "M5.5 15.5C2.5 18 2 19.5 3 20.5c1.5 1.5 8-1.5 13.5-7S22.5 4.5 21 3c-1-1-2.5-.5-5 2.5"), "planet space universe", "행성 우주"],
  ["earth", j(ci(12, 12, 9), "M5 7c2 1 3 0 4 2s-1 3 1 4 1 3 0 5 M14 3.5c-1 2 0 3 2 3.5s3 2 4.5 1.5 M15 20c0-2 1-3 2.5-3.5"), "earth global world", "지구 글로벌 세계"],
  ["thermometer", "M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z M12 9v8", "temperature heat", "온도 기온"],
  ["storm", "M7 15a5 5 0 0 1-.5-10A6 6 0 0 1 18 6a4.5 4.5 0 0 1-.5 9 M13 11l-3 5h4l-3 5", "storm thunder", "폭풍 천둥 번개"],
  ["sunrise", "M3 18h18 M7 18a5 5 0 0 1 10 0 M12 4v5 M9 6l3-3 3 3 M4.2 11.2l1.4 1.4 M19.8 11.2l-1.4 1.4 M5 21h14", "sunrise morning start", "일출 아침 시작"],
  ["shell", "M12 21c-5 0-9-4-9-9 3-6 15-6 18 0 0 5-4 9-9 9z M12 21V8 M8 20l1-11 M16 20l-1-11", "shell beach coast", "조개 해변 바닷가"],
  ["fish", "M3 12c3-5 10-6 15 0-5 6-12 5-15 0z M18 12l3-3v6z M8 11.5h.01", "fish sea seafood", "물고기 수산 해산물"],
  ["bird", "M3 12c4 0 6-2 7-6 1 4 3 6 7 6l4-2-2 4c-2 3-5 5-9 5-3 0-5-2-7-7z", "bird freedom fly", "새 자유 비상"],
  ["butterfly", "M12 7v12 M12 10C10 5 4 3 3 6s2 7 9 6 M12 10c2-5 8-7 9-4s-2 7-9 6 M12 13c-3 0-7 2-6 5s5 1 6-3 M12 13c3 0 7 2 6 5s-5 1-6-3", "butterfly change transform", "나비 변화 전환"],
  ["feather", "M20 4C12 4 6 10 6 18 M6 18l-2 2 M6 18c6 0 10-3 12-8 M10 14h5", "feather light writing", "깃털 가벼움 글"],
];

const KOREAN: Row[] = [
  ["swirl-balance", j(ci(12, 12, 9), "M3 12a4.5 4.5 0 0 1 9 0 4.5 4.5 0 0 0 9 0"), "balance swirl harmony", "조화 균형 소용돌이"],
  ["hanok-roof", "M2 10c3 0 5-2 6-5h8c1 3 3 5 6 5 M5 9v11 M19 9v11 M3 20h18 M9 20v-6h6v6 M8 5V3h8v2", "hanok traditional house roof", "한옥 기와 지붕 전통가옥"],
  ["lotus", "M12 20c-4 0-8-2-9-6 3-1 6 0 9 2 3-2 6-3 9-2-1 4-5 6-9 6z M12 16c-2-3-2-7 0-11 2 4 2 8 0 11z M8 15c-2-2-2-5-1-8 2 1 4 3 4 6 M16 15c2-2 2-5 1-8-2 1-4 3-4 6", "lotus temple calm", "연꽃 사찰 평온"],
  ["knot", "M12 3l4 4-4 4-4-4z M12 11l4 4-4 4-4-4z M8 7 4 11l4 4 M16 7l4 4-4 4 M12 19v3", "knot maedeup tradition", "매듭 전통매듭 인연"],
  ["fan", "M12 20 3 9a12 12 0 0 1 18 0z M12 20 7.5 5 M12 20l4.5-15 M12 20V4", "fan buchae dance", "부채 부채춤 전통"],
  ["mask", "M5 5c2-1.5 12-1.5 14 0 1 6-1 15-7 15S4 11 5 5z M8 10c.8-.8 2.2-.8 3 0 M13 10c.8-.8 2.2-.8 3 0 M9 15c2 1.5 4 1.5 6 0", "mask tal theater", "탈 탈춤 공연"],
  ["drum", "M4 8c0-1.7 3.6-3 8-3s8 1.3 8 3v8c0 1.7-3.6 3-8 3s-8-1.3-8-3z M4 8c0 1.7 3.6 3 8 3s8-1.3 8-3 M3 3l6 5 M21 3l-6 5", "drum buk rhythm", "북 장단 리듬"],
  ["pagoda", "M12 2v3 M7 5h10l-1 3H8z M6 8h12 M8 8v3 M16 8v3 M5 11h14l-1 3H6z M8 14v3 M16 14v3 M4 17h16l-1 3H5z M3 22h18", "pagoda stone tower heritage", "석탑 탑 문화유산"],
  ["lantern", "M12 2v3 M8 5h8l1 3H7z M7 8h10v9H7z M8 17h8l-1 3H9z M12 20v2 M7 12.5h10", "lantern cheongsachorong festival", "청사초롱 등불 축제"],
  ["gat", "M2 15c0 1.5 4.5 2.5 10 2.5S22 16.5 22 15s-4.5-2-10-2-10 .5-10 2z M8.5 13.5V8a3.5 2 0 0 1 7 0v5.5 M12 17.5v4", "gat hat scholar", "갓 선비 전통모자"],
  ["crane-bird", "M4 18c3 0 5-1 7-3l2-6c.5-2 2-3 4-3l3 1-3 1 M13 9c2 1 4 3 4 6 M11 15l-3 6 M12 14l1 7", "crane bird longevity", "학 장수 길조"],
  ["cloud-motif", "M3 14a3 3 0 0 1 3-3 3.5 3.5 0 0 1 6.5-1.5A3 3 0 0 1 18 11a3 3 0 0 1 0 6H6a3 3 0 0 1-3-3z M8 14a1.5 1.5 0 0 1 3 0 M13 13a1.5 1.5 0 0 1 3 0", "auspicious cloud gureum", "구름무늬 길상 운문"],
  ["water-arcs", "M2 20a5 5 0 0 1 10 0 M4.5 20a2.5 2.5 0 0 1 5 0 M12 20a5 5 0 0 1 10 0 M14.5 20a2.5 2.5 0 0 1 5 0 M7 14a5 5 0 0 1 10 0 M9.5 14a2.5 2.5 0 0 1 5 0", "water pattern arcs", "물결무늬 파문"],
  ["ink-mountains", "M2 19c3-2 4-8 7-8s4 5 6 5 2-3 3-3 3 3 4 6 M2 21h20 M9 11c0-2 1-5 3-6", "ink landscape mountains", "수묵 산수화 산"],
  ["pine", "M12 21v-3 M12 3 7 9h3l-4 5h4l-5 4h14l-5-4h4l-4-5h3z", "pine sonamu evergreen", "소나무 늘푸른 절개"],
  ["plum-blossom", j(ci(12, 7.5, 2.6), ci(16.28, 10.61, 2.6), ci(14.65, 15.64, 2.6), ci(9.35, 15.64, 2.6), ci(7.72, 10.61, 2.6), ci(12, 12, 1)), "plum blossom maehwa spring", "매화 봄 꽃"],
  ["bamboo", "M9 3v18 M15 5v16 M7 8h4 M7 14h4 M13 11h4 M13 17h4 M9 6c2-2 4-2 6-1 M15 9c2-1 4-1 5 1", "bamboo integrity", "대나무 지조 대숲"],
  ["moon-jar", "M9 3h6 M9 3c-1 1-1 2 0 2.5C4.5 7 3 10.5 3 13c0 5 4 8 9 8s9-3 9-8c0-2.5-1.5-6-6-7.5 1-.5 1-1.5 0-2.5", "moon jar porcelain craft", "달항아리 백자 공예"],
  ["dojang", j(rc(5, 5, 14, 14, 2), "M8.5 8.5h7v7h-7z M12 8.5v7"), "seal dojang stamp name", "도장 인장 낙관"],
  ["calligraphy", "M14 3l7 7-6 6-7-7z M8 9l-4 4c-1.5 1.5-1 4-2 7 3-1 5.5-.5 7-2l4-4", "calligraphy brush seoye", "서예 붓글씨 먹"],
  ["yut", "M5 4l2 16 M10 3v18 M14 3v18 M19 4l-2 16 M9 8h2 M13 8h2", "yut game sticks holiday", "윷놀이 윷 명절"],
  ["yeon-kite", j(rc(5, 3, 14, 18, 1), ci(12, 11, 3), "M5 3l14 18 M19 3 5 21"), "kite yeon traditional", "연 방패연 연날리기"],
  ["onggi", "M8 3h8 M8 3c0 1-1 2-3 3-2 2-2 5-2 8 0 4 3 7 9 7s9-3 9-7c0-3 0-6-2-8-2-1-3-2-3-3 M7 9h10", "onggi jar fermentation", "옹기 항아리 발효"],
  ["sujeo", "M7 3c-1.7 0-3 1.8-3 4s1.3 4 3 4 3-1.8 3-4-1.3-4-3-4z M7 11v10 M15 3l1 18 M19 3l-1 18", "spoon chopsticks sujeo dining", "수저 숟가락 젓가락"],
  ["hangul", j("M8 4h8 M5 8h14", ci(12, 15, 4)), "hangul korean letter", "한글 글자 히읗"],
];

const GROUPS: [IconCategory, Row[]][] = [
  ["contact", CONTACT],
  ["social", SOCIAL],
  ["business", BUSINESS],
  ["industry", INDUSTRY],
  ["objects", OBJECTS],
  ["arrows", ARROWS],
  ["status", STATUS],
  ["nature", NATURE],
  ["korean", KOREAN],
];

export const ICON_BANK: readonly BankIcon[] = GROUPS.flatMap(([category, rows]) =>
  rows.map(([id, d, en, ko]) => ({ id, category, d, en: en.split(/\s+/), ko: ko.split(/\s+/) })),
);

const BY_ID = new Map(ICON_BANK.map((i) => [i.id, i]));

export function getBankIcon(id: string): BankIcon | undefined {
  return BY_ID.get(id);
}

export function isBankIconId(id: string): boolean {
  return BY_ID.has(id);
}

/** Case-insensitive ko/en keyword search (id, keywords, category label). Empty query → all (optionally by category). */
export function searchIcons(query: string, category?: IconCategory | null): BankIcon[] {
  const q = query.trim().toLowerCase();
  return ICON_BANK.filter((i) => {
    if (category && i.category !== category) return false;
    if (!q) return true;
    const label = ICON_CATEGORY_LABEL[i.category];
    return i.id.includes(q) || i.en.some((k) => k.toLowerCase().includes(q)) || i.ko.some((k) => k.includes(q)) || label.ko.includes(q) || label.en.toLowerCase().includes(q);
  });
}
