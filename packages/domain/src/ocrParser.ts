// F-015, F-016, F-017, F-018: OCR 토큰 → 타입 필드. 원문에 없는 값은 절대 생성하지 않는다.
import { normalizeEmail, normalizePersonName, normalizePhone, normalizeUrl } from "./normalize";

export type Provenance = "ocr" | "user" | "sync" | "ai_inferred" | "exchange";

export interface OcrLine {
  text: string;
  /** 0..1 confidence from the OCR engine */
  confidence?: number;
  /** bounding box in image pixels */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export type FieldKey =
  | "fullName"
  | "company"
  | "jobTitle"
  | "department"
  | "email"
  | "mobile"
  | "phone"
  | "fax"
  | "address"
  | "website"
  | "sns";

export interface ExtractedField {
  key: FieldKey;
  value: string; // exactly as it appears in the source line (trimmed)
  normalized?: string | null;
  confidence: number; // 0..1
  provenance: Provenance;
  sourceLine: number; // index into lines
  bbox?: OcrLine["bbox"];
}

export interface ExtractionResult {
  fields: ExtractedField[];
  unassigned: { line: number; text: string }[];
  language: "ko" | "en" | "ja" | "zh" | "mixed";
}

/** F-018: 이 값 미만이면 사용자 확인 대상 */
export const REVIEW_THRESHOLD = 0.75;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|kr|jp|cn|app|dev|me|biz|info|xyz|tech|studio|design)(?:\.[a-z]{2})?(?:\/[^\s]*)?/gi;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}/g;
/*
 * 국제표기 — 프랑스 +33 6 12 34 56 78 처럼 두 자리씩 끊어 적는 나라가 많아
 * PHONE_RE 의 '3~4자리+4자리' 꼴에 걸리지 않는다. 바이어 명함에는 그 꼴이 흔하다.
 * 반드시 '+' 로 시작하게 묶는다 — 안 그러면 주소의 번지를 번호로 오인한다.
 */
const INTL_PHONE_RE = /\+\d[\d\s.()-]{6,20}\d/g;
/*
 * 국내 표준꼴 — 0 으로 시작하는 지역·이동전화. 느슨한 PHONE_RE 보다 먼저 본다.
 * OCR 이 라벨을 숫자로 흘리면("H.P" → "10616") 느슨한 쪽이 그 찌꺼기를 번호
 * 앞머리로 물어 "10616 010-9494" 를 만든다. 괄호 지역번호 "02)336-7788" 포함.
 */
/*
 * 구분자에 쉼표를 넣어 둔다 — 점을 쉼표로 읽는 일이 잦다("T02.564,1253").
 * 0 으로 시작하는 번호 꼴만 보므로 주소의 "14,443" 같은 수는 걸리지 않는다.
 */
/*
 * 앞이 `\b` 였을 때 라벨이 번호에 딱 붙으면 통째로 놓쳤다 — "T02.564,1253" 은 T 와 0
 * 사이에 낱말 경계가 없다. 숫자만 앞에 오지 않으면 되므로 전후를 숫자로만 막는다.
 *
 * 구분자를 두 글자까지 받는 것은 점 뒤에 공백을 두고 찍는 명함 때문이다
 * ("Mobile 010. 5658. 0958", "tel 02. 6959. 2558"). 한 글자만 받으면 통째로 놓친다.
 */
const KR_PHONE_RE = /(?<!\d)0\d{1,2}\)?[\s.,-]{0,2}\d{3,4}[\s.,-]{0,2}\d{4}(?!\d)/g;
/*
 * 나라번호별 휴대폰 앞자리(국내번호 기준, 트렁크 0 을 뗀 뒤).
 * 라벨이 없거나 OCR 이 라벨을 못 읽은 번호를 휴대폰/유선으로 가른다 —
 * 상담 뒤 문자를 보내려면 둘을 섞으면 안 된다. 가를 수 없는 나라는 넣지 않는다.
 */
const MOBILE_PREFIX: Record<string, RegExp> = {
  "82": /^1[016789]/, "81": /^[789]0/, "86": /^1[3-9]/, "44": /^7/, "49": /^1[5-7]/,
  "33": /^[67]/, "39": /^3/, "34": /^[67]/, "31": /^6/, "65": /^[89]/, "852": /^[569]/,
  "886": /^9/, "66": /^[689]/, "84": /^[35789]/, "62": /^8/, "60": /^1/, "63": /^9/,
  "91": /^[6-9]/, "971": /^5/, "61": /^4/, "7": /^9/, "90": /^5/, "966": /^5/,
};
const ZERO_TRUNK_CC = new Set(["82", "81", "86", "44", "49", "33", "31", "886", "66", "84", "62", "60", "63", "91", "971", "61", "90", "966"]);

/** 국제표기 번호가 휴대폰으로 보이는가 (모르면 false) */
function intlLooksMobile(raw: string): boolean {
  const s = raw.trim();
  let digits = s.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (s.startsWith("+")) { /* 그대로 */ }
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else return false;
  for (let len = 3; len >= 1; len--) {
    const cc = digits.slice(0, len);
    const re = MOBILE_PREFIX[cc];
    if (!re) continue;
    let rest = digits.slice(len);
    if (ZERO_TRUNK_CC.has(cc) && rest.startsWith("0")) rest = rest.slice(1);
    return re.test(rest);
  }
  return false;
}
const SNS_RE = /\b(?:linkedin\.com\/in\/[\w-]+|instagram\.com\/[\w.]+|x\.com\/\w+|twitter\.com\/\w+|github\.com\/[\w-]+|@[a-z0-9_.]{3,30})\b/gi;

/*
 * 라벨과 번호 사이에 오는 것은 제각각이다 — "FAX : (031)205-6376" 처럼 지역번호
 * 괄호가 먼저 열리기도 한다. 그 '(' 를 끝에 허용하지 않으면 팩스 판정을 통째로 비켜 간다.
 */
const LABEL_MOBILE = /(?:^|[\s|/])(?:m|mob|mobile|h\.?p|cell|휴대폰|휴대전화|핸드폰|携帯|手机)[\s.:)(]*$/i;
const LABEL_FAX = /(?:^|[\s|/])(?:f|fax|팩스|传真)[\s.:)(]*$/i;
const LABEL_TEL = /(?:^|[\s|/])(?:t|tel|phone|office|전화|대표|直通|电话)[\s.:)(]*$/i;
/** 메일 주소 바로 앞에 오는 라벨 — 이게 아니면 주소 앞머리가 잘렸을 수 있다 */
const LABEL_EMAIL = /^(?:e|e-?mail|mail|이메일|메일|電子メール|邮箱)[.:)]?$/i;

/**
 * OCR 이 흘린 찌꺼기를 치우고, 음절마다 끊어 놓은 줄을 되붙인다.
 *
 * tesseract 는 한국어 명함에서 "최 민 서", "( 주 ) 그 린 코 스 메 틱" 처럼
 * 글자마다 공백을 넣는다. 실제로 찍은 사진에서는 인쇄선·테두리가 글자로 섞여
 * 들어오는 것도 그만큼 잦다("| 영업지원팀", "최민서 a", "강태웅 33", 선만 남은 "|").
 * 분류하기 전에 여기서 치운다. 글자를 지어내지는 않는다 — 지우고 붙일 뿐이다.
 */
export function tidyOcrText(text: string | null | undefined): string {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  /*
   * ① 홀로 선 막대 — 한글이 없는 줄("| Export Division")에서도 치운다.
   * 줄 앞뒤만 본다. 가운데 막대는 인쇄선이 아니라 칸을 나누는 구분자이고
   * ("Maria Smith | Engineering Dept. | Director"), 그걸 지우면 아래 분류가
   * 이름·부서·직책을 한 덩어리로 보게 된다.
   */
  const isBar = (t: string) => /^[|｜ㅣl]$/.test(t);
  const edge = s.split(" ").filter(Boolean);
  while (edge.length && isBar(edge[0]!)) edge.shift();
  while (edge.length && isBar(edge[edge.length - 1]!)) edge.pop();
  s = edge.join(" ").trim();
  // 세로 인쇄선이 첫 글자에 붙어 들어오기도 한다 ("|이사" → "이사")
  s = s.replace(/^[|｜]+\s*/, "");
  if (!s) return "";
  // ②-1 메일 주소 안의 쉼표는 점을 잘못 읽은 것이다 ("ha,joo@…")
  if (s.includes("@")) {
    s = s.split(" ").map((t) => (t.includes("@") ? t.replace(/,/g, ".") : t)).join(" ");
  }
  const hasGraph = (x: string) => /[\p{L}\p{N}]/u.test(x);
  // 한자·가나 줄도 아래 정리를 거치게 한다 — "李建国 此" 같은 찌꺼기가 붙는다
  if (!/[가-힣一-鿿぀-ヿ]/.test(s)) return hasGraph(s) ? s : "";
  s = s.replace(/([([])\s+/g, "$1").replace(/\s+([)\]])/g, "$1");
  let toks = s.split(" ").filter(Boolean);
  // ③ 줄 앞뒤에 붙은 한 글자짜리 찌꺼기 (가운데 것은 ①과 같은 이유로 구분자로 둔다)
  const isJunkTok = (t: string) => /^[A-Za-z]$|^[^\p{L}\p{N}]+$/u.test(t);
  while (toks.length >= 2 && isJunkTok(toks[0]!)) toks.shift();
  while (toks.length >= 2 && isJunkTok(toks[toks.length - 1]!)) toks.pop();
  // ④ 이름 꼴 뒤에 붙은 짧은 찌꺼기 ("강태웅 33", "송예린 ze")
  if (toks.length === 2 && /^[가-힣]{2,4}$/.test(toks[0]!) && toks[1]!.length <= 2 && !/[가-힣]/.test(toks[1]!)) {
    toks = [toks[0]!];
  }
  // 한자 이름 뒤에도 같은 찌꺼기가 붙는다("李建国 此"). 이름을 띄어 쓰는 나라가
  // 있어("佐藤 健一") 두 글자 이상이면 두고, 한 글자만 떨어져 붙으면 버린다.
  if (toks.length === 2 && /^[一-鿿぀-ヿ]{2,4}$/.test(toks[0]!) && /^[一-鿿぀-ヿ]$/.test(toks[1]!)) {
    toks = [toks[0]!];
  }
  // ⑤ 한 글자 한글 토큰이 2개 이상 이어지면 한 낱말로 ("구 매 팀 차장" → "구매팀 차장")
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push(run.length >= 2 ? run.join("") : run[0]!);
    run = [];
  };
  for (const t of toks) {
    if (/^[가-힣]$/.test(t)) run.push(t);
    else { flush(); out.push(t); }
  }
  flush();
  s = out.join(" ").trim();
  return hasGraph(s) ? s : "";
}

/** 줄 앞의 목록 기호·순번만 뗀다. 숫자가 이어지면(전화번호 앞머리) 그대로 둔다. */
function stripReplyMarker(line: string): string {
  const bulleted = line.replace(/^[-*·•]\s*/, "");
  // "1." · "2)" 같은 순번은 뗀다. "010. 5658…" 의 "010." 은 뒤가 또 숫자라 순번이 아니다.
  const m = /^(\d{1,2})[.)]\s*(.*)$/.exec(bulleted);
  return m && !/^\d/.test(m[2]!) ? m[2]! : bulleted;
}

/**
 * F-015 비전 OCR 어댑터 응답을 한 줄씩 끊어 손질한다 — 모델이 가끔 붙이는 목록 기호
 * (•·-*)와 순번("1." · "2)")을 떼고, 공백을 한 칸으로 줄이고, 코드펜스(```)와 빈 줄을 버린다.
 *
 * **전화번호처럼 숫자로 이어지는 줄은 순번으로 오인해 지우지 않는다** — "010. 5658. 0958"
 * 의 "010." 을 순번으로 보고 떼면 번호 앞머리가 통째로 사라져, 뒤의 결정적 파서가
 * 아무리 그 형식을 받아들여도 "010" 을 되살릴 수 없다. 지우고 떼기만 하고 글자는
 * 지어내지 않는다(규칙 6).
 */
export function cleanVisionOcrLines(reply: string | null | undefined, max = 120): string[] {
  return String(reply ?? "")
    .split(/\r?\n/)
    .map((raw) => stripReplyMarker(raw.replace(/\s+/g, " ").trim()))
    .filter((t) => t && !t.startsWith("```"))
    .slice(0, max);
}

const TITLE_WORDS = [
  "대표이사", "대표", "회장", "사장", "부사장", "전무", "상무", "이사", "본부장", "실장", "센터장", "부장", "차장", "과장",
  "대리", "주임", "사원", "팀장", "파트장", "매니저", "수석", "책임", "선임", "연구원", "교수", "변호사", "회계사", "변리사",
  "디자이너", "개발자", "엔지니어", "컨설턴트", "프로", "원장", "소장",
  // 전문자격 — 명함에 직책 대신 이것만 적는 경우가 많다 ("공인회계사/세무사")
  "세무사", "노무사", "법무사", "관세사", "감정평가사", "건축사", "약사", "의사", "한의사",
  "ceo", "cto", "cfo", "coo", "cmo", "cpo", "founder", "co-founder", "president", "vice president", "vp", "director",
  "manager", "engineer", "designer", "developer", "consultant", "partner", "principal", "head of", "lead", "officer",
  "associate", "analyst", "specialist", "architect", "researcher", "professor", "attorney", "owner",
  "leader", "senior", "supervisor", "executive", "chief", "advisor",
  "社長", "部長", "課長", "取締役", "代表", "经理", "总监", "总经理",
];
const COMPANY_MARKERS = [
  /\(주\)/, /㈜/, /주식회사/, /유한회사/, /株式会社/, /有限公司/, /集团/,
  /\b(inc|corp|corporation|co\.,?\s*ltd|ltd|llc|gmbh|limited|plc|group|holdings|labs?|studio|partners|ventures|capital|technology|technologies|systems|solutions|consulting|cosmetics|beauty)\b\.?/i,
  /(그룹|홀딩스|컴퍼니|랩스|스튜디오|벤처스|파트너스|테크|솔루션|시스템즈|코리아|코스메틱|뷰티)$/,
  /*
   * 한국 상호에 흔한 업종 꼬리말. 법인 표기(㈜)를 빼고 인쇄한 명함이 많아
   * 위의 표기만으로는 회사 줄을 못 잡는다. 실제 사진 묶음에서 회사 줄이 통째로
   * 버려진 것들을 보고 늘렸다 (KBT 2026-10: 대광정밀·가온제과·세종메디칼 …).
   * 부서 꼬리말(팀·부·실·본부·센터)로 끝나는 말은 일부러 넣지 않았다.
   */
  /(무역|상사|물산|산업|제약|화학|식품|전자|유통|코퍼레이션|인터내셔널|글로벌)$/,
  /(정밀|제과|제지|기업|공업|중공업|기계|금속|전기|섬유|건설|에너지|교역|통상|종합상사)$/,
  /(메디칼|메디컬|바이오|제약사|파마|팜|헬스케어|네트웍스|네트웍|네트워크|인더스트리|엔지니어링|모터스|어패럴|리빙|푸드|트레이딩)$/,
  // 전문직 법인 — '법인' 으로 끝나는 상호를 놓치면 회사 칸이 통째로 빈다 ("서율회계법인")
  /(회계법인|법무법인|세무법인|특허법인|법률사무소|노무법인|의료법인|재단법인|사단법인|법인)$/,
];
const DEPT_MARKERS = [/(팀|부|본부|실|센터|사업부|연구소|그룹)$/, /\b(dept\.?|department|division|team|office of|group)\b/i, /(部|课|課)$/];
/*
 * 회사 판정이 비켜 가야 할 부서 꼬리말. DEPT_MARKERS 에서 '그룹·group' 만 뺀
 * 것이다 — 그 말은 회사 이름에도 그대로 쓰여("Lumiere Beauty Group", "한빛그룹")
 * 부서로만 보면 멀쩡한 회사 줄을 놓친다.
 */
const DEPT_NOT_COMPANY = [/(팀|부|본부|실|센터|사업부|연구소)$/, /\b(dept\.?|department|division|team|office of)\b/i, /(部|课|課)$/];
const ADDRESS_MARKERS = [
  /(특별시|광역시|특별자치시|[가-힣]+시\s|[가-힣]+구\s|[가-힣]+군\s|[가-힣]+로\s?\d|[가-힣]+길\s?\d|[가-힣]+동\s?\d|번지|층|호$)/,
  /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/,
  /\b(street|st\.|road|rd\.|avenue|ave\.|suite|floor|blvd|building|bldg)\b/i,
  /*
   * 로마자로 적은 한국 주소 — "14, 443, Anaji-ro, Gyeyang-gu," · "1F, 155-11, Hannam-dong,".
   * street·road 같은 말을 쓰지 않아 위 목록으로는 하나도 안 걸렸고, 영문 주소가 통째로
   * 버려졌다(측정 묶음 13장 중 2장).
   */
  /\b[a-z]+-(ro|gil|dong|gu|si|eup|myeon|ri|daero)\b/i,
  /(都|道|府|県|市|区|町|号|路|楼)/,
];

function lineConf(l: OcrLine): number {
  const c = l.confidence;
  if (c === undefined || Number.isNaN(c)) return 0.85;
  return Math.max(0, Math.min(1, c > 1 ? c / 100 : c));
}

function detectLanguage(text: string): ExtractionResult["language"] {
  const ko = (text.match(/[가-힣]/g) ?? []).length;
  const ja = (text.match(/[぀-ヿ]/g) ?? []).length;
  const zh = (text.match(/[一-鿿]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = ko + ja + zh + en || 1;
  // Latin-heavy tokens (email/URL) are common on any card, so CJK scripts win at a lower share.
  if (ko / total > 0.3 && ko >= ja && ko >= zh) return "ko";
  if (ja / total > 0.2) return "ja";
  if (zh / total > 0.3) return "zh";
  if (en / total > 0.8) return "en";
  return "mixed";
}

function bboxHeight(l: OcrLine): number {
  return l.bbox ? l.bbox.y1 - l.bbox.y0 : 0;
}

/**
 * 흔한 한국 성씨 — 두 글자 후보가 사람 이름인지 업무 낱말('영업'·'구매')인지
 * 가를 때만 쓴다. 이름 전체를 이 목록으로 거르지는 않는다.
 */
const SURNAMES = new Set(
  ("김 이 박 최 정 강 조 윤 장 임 한 오 서 신 권 황 안 송 류 전 홍 고 문 양 손 배 백 허 유 남 심 노 하 곽 성 차 주 우 구 " +
   "민 진 지 엄 채 원 천 방 공 현 함 변 염 여 추 도 소 석 선 설 마 길 연 위 표 명 기 반 왕 금 옥 육 인 맹 제 모 탁 국 어 은 편 용 예 봉")
    .split(" ").filter(Boolean),
);

/**
 * 한글 이름처럼 보이는가.
 *
 * 글자 수만 보면 부서명이 이름으로 잡힌다 — '마케팅팀' 은 네 글자라 조건을
 * 통과해 버리고, 정작 다른 줄의 '김수민' 이 분류되지 못한 채 남는다.
 * 그래서 부서 꼬리말로 끝나는 세 글자 이상은 이름으로 보지 않는다.
 */
/*
 * 조직 단위 꼬리말 — 이것으로 끝나는 세 글자 이상은 사람 이름으로 보지 않는다.
 * '점' 은 지점 이름이다("선릉점"). 가게 명함은 상호·지점·직책·이름 순으로 찍어서,
 * 지점 이름이 이름보다 먼저 나오고 성씨처럼 시작하기까지 한다(선 → 성씨 목록에 있다).
 */
const DEPT_TAIL = /(본부|사업부|연구소|센터|그룹|지점|팀|부|실|점)$/;

/*
 * 조사로 끝나는 줄은 이름이 아니라 문구의 조각이다 — "건강컨설팅의 프로" 가 상자
 * 둘로 끊기면 "건강컨설팅의" 가 남아 회사 칸에 들어앉는다. 상호가 '의'·'은'·'를' 로
 * 끝나는 일은 없다. ('암웨이' 처럼 '이' 로 끝나는 상호는 흔하므로 '이' 는 넣지 않는다.)
 */
const PARTICLE_TAIL = /(의|은|는|을|를|에서|부터|까지|에게|한테)$/;
function looksLikeKoreanName(s: string): boolean {
  const n = normalizePersonName(s);
  if (!/^[가-힣]{2,4}$/.test(n)) return false;
  if (n.length >= 3 && DEPT_TAIL.test(n)) return false;
  return true;
}

/**
 * 사람 이름일 가능성이 '충분히 높은가' — 애매한 줄에서만 쓰는 좁은 판정.
 * 두 글자 후보는 성씨로 시작할 때만 이름으로 본다("영업"·"구매" 를 막는다).
 */
function looksLikePersonNameStrict(s: string): boolean {
  const n = normalizePersonName(s);
  if (!looksLikeKoreanName(n)) return false;
  if (n.length >= 3) return true;
  return SURNAMES.has(n.charAt(0));
}

/*
 * 대문자로 시작하는 두 낱말이면 전부 사람 이름처럼 보인다 — "Medical Community",
 * "Total Solution", "Global Partners" 가 이름 칸에 들어앉았다. 사람 이름에 쓰이지 않는
 * 흔한 업무 낱말이 하나라도 섞이면 이름으로 보지 않는다. 성씨 목록처럼 이름을
 * 가려내는 사전이 아니라, '이것은 이름이 아니다' 만 거르는 짧은 목록이다.
 */
const NOT_A_NAME = new Set(
  ("medical community technology technologies solution solutions marketing sales service services consulting " +
   "design studio group partners partner global korea international trading industry industries system systems " +
   "network networks digital creative media communication communications research institute center centre " +
   "company corporation enterprise holdings ventures capital labs lab works factory total premium smart " +
   "reservation only since est estd").split(" "),
);
function looksLikeLatinName(s: string): boolean {
  const t = s.trim();
  if (!/^[A-Z][a-zA-Z'’-]+(?:\s[A-Z][a-zA-Z'’.-]+){1,2}$/.test(t) || /\d/.test(t)) return false;
  return !t.split(/\s+/).some((w) => NOT_A_NAME.has(w.replace(/[^a-zA-Z]/g, "").toLowerCase()));
}

/**
 * 일본·중국 이름처럼 보이는가 ("佐藤 健一", "王雪梅").
 * 한자 두세 글자는 직책("部長")·부서("采购部")와도 겹치므로 그 둘을 먼저 뺀다.
 */
function looksLikeCjkName(s: string): boolean {
  const n = s.trim();
  if (!/^[一-鿿぀-ヿ]{1,3}(?:\s[一-鿿぀-ヿ]{1,3})?$/.test(n)) return false;
  if (n.replace(/\s/g, "").length < 2) return false;
  if (hasTitleWord(n)) return false;
  return !DEPT_MARKERS.some((re) => re.test(n));
}

/** 어느 나라 이름이든 '이름 줄' 로 보이는가 */
function looksLikeAnyName(s: string): boolean {
  return looksLikeKoreanName(s) || looksLikeLatinName(s) || looksLikeCjkName(s);
}

/*
 * ㈜ 는 한 글자짜리 기호라 OCR 이 거의 늘 준·쥐·주·순 같은 글자로 읽는다.
 * 떼어 낸 값은 원문의 부분 문자열이라 '지어내지 않는다' 규칙을 깨지 않는다.
 * 멀쩡한 상호를 깎지 않도록 좁게 건다 — 나머지가 그 자체로 회사 이름처럼
 * 보일 때만이다('준오헤어' 는 나머지가 어떤 꼬리말과도 맞지 않아 그대로 둔다).
 */
const MISREAD_CORP = /^[준쥐주순죽쭈]/;
function misreadCorpRest(text: string): string | null {
  const s = String(text ?? "");
  if (!MISREAD_CORP.test(s)) return null;
  if (/^주식회사|^주식|^\(주\)|^㈜/.test(s)) return null;
  const rest = s.slice(1).replace(/^[\s)\].,]+/, "");
  return rest.length >= 3 ? rest : null;
}
function stripMisreadCorp(text: string): string {
  const rest = misreadCorpRest(text);
  if (!rest) return text;
  if (!COMPANY_MARKERS.some((re) => re.test(rest))) return text;
  return rest;
}
/** 업종 꼬리말이 없는 상호 앞의 '㈜ 오읽음' 까지 회사로 본다 ("순퓨어스킨") */
function misreadCorpCompany(text: string): string | null {
  const s = String(text ?? "").trim();
  if (/\s/.test(s) || s.length < 4 || s.length > 20) return null;
  const rest = misreadCorpRest(s);
  /*
   * 나머지가 네 글자는 돼야 한다. 세 글자까지 허용하면 '준오헤어'(실존 상호)의
   * 첫 글자를 깎아 '오헤어' 로 만든다. 측정 묶음의 ㈜ 상호는 모두 네 글자 이상이다.
   */
  if (!rest || !/^[가-힣]{4,}$/.test(rest)) return null;
  if (DEPT_MARKERS.some((re) => re.test(rest))) return null;
  if (hasTitleWord(rest)) return null;
  return rest;
}

/** Smallest slice of `text` that contains `parts` in order (null when they cannot be located in order). */
function sliceSpanning(text: string, parts: string[]): string | null {
  if (!parts.length) return null;
  let from = 0;
  let start = -1;
  let end = -1;
  for (const p of parts) {
    const at = text.indexOf(p, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    end = at + p.length;
    from = end;
  }
  return text.slice(start, end);
}

/*
 * 한글 직책은 낱말 경계가 없어 그냥 포함 검사를 하면 더 긴 낱말 안에서 걸린다 —
 * "AI 프로그램 개발" 의 '프로그램' 이 직책 '프로' 로 잡혀 그 줄이 직책 칸에 앉았다.
 * 한국어 직책은 거의 다 꼬리말이므로 "뒤에 한글이 더 붙지 않을 것" 만 요구한다
 * (대표이사 ✓, 요트투어의 프로 ✓, 프로그램 ✗).
 */
function hasTitleWord(s: string): string | null {
  const low = s.toLowerCase();
  for (const w of TITLE_WORDS) {
    const re = /^[a-z\s-]+$/.test(w)
      ? new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, "[-\\s]")}([^a-z]|$)`, "i")
      : new RegExp(`${w}(?![가-힣])`);
    if (re.test(re.flags.includes("i") ? low : s)) return w;
  }
  return null;
}

/**
 * Parse OCR lines into typed contact fields. Every returned value is a substring
 * of an input line — the parser never fabricates values (백서 1.1, 17).
 */
export function parseBusinessCard(lines: OcrLine[]): ExtractionResult {
  const fields: ExtractedField[] = [];
  const used = new Set<number>();
  /*
   * 분류 전에 tidyOcrText 를 거친다. 공백만 접고 넘기면 "최 민 서"·"| 영업지원팀" 같은
   * 줄이 그대로 들어와, 아래 규칙이 전부 헛돈다 — KBT 쪽 측정에서 올린 수치는 이 정리를
   * 거친 입력에서 나온 것이다. 지우고 붙일 뿐이라 '지어내지 않는다' 규칙은 그대로다.
   */
  const clean = lines.map((l) => ({ ...l, text: tidyOcrText(l.text) }));

  const push = (f: ExtractedField) => {
    if (!fields.some((x) => x.key === f.key && x.value === f.value)) fields.push(f);
  };

  clean.forEach((l, i) => {
    if (!l.text) return;
    const conf = lineConf(l);
    let consumed = false;

    for (const m of l.text.matchAll(EMAIL_RE)) {
      /*
       * 주소 앞머리가 잘렸을지 모르는 경우를 알아본다 — OCR 이 점을 공백으로
       * 흘리면 "Email sera hong@…" 처럼 되어 "hong@…" 만 잡힌다. 글자를 지어내
       * 붙일 수는 없으니(없는 주소가 된다) 확신을 낮춰 '확인 필요' 로 띄운다.
       */
      const prev = /(\S+)\s$/.exec(l.text.slice(0, m.index ?? 0))?.[1] ?? "";
      const local = m[0].split("@")[0] ?? "";
      const cut =
        (!!prev && /[A-Za-z0-9]/.test(prev) && /^[A-Za-z0-9._%+-]+$/.test(prev) && !LABEL_EMAIL.test(prev)) ||
        /^\.|\.$/.test(local);
      push({ key: "email", value: m[0], normalized: normalizeEmail(m[0]), confidence: conf * (cut ? 0.6 : 0.98), provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    const withoutEmail = l.text.replace(EMAIL_RE, " ");

    for (const m of withoutEmail.matchAll(SNS_RE)) {
      if (m[0].startsWith("@") && /\.[a-z]{2,}$/i.test(m[0])) continue;
      push({ key: "sns", value: m[0], normalized: m[0].toLowerCase(), confidence: conf * 0.9, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    const withoutSns = withoutEmail.replace(SNS_RE, " ");

    for (const m of withoutSns.matchAll(URL_RE)) {
      const norm = normalizeUrl(m[0]);
      if (!norm) continue;
      /*
       * 법인 표기 안의 약어를 주소로 오인하지 않는다 — "SAE JEUN CONST.CO.,LTD." 의
       * 'CONST.CO' 가 .co 도메인으로 잡혀 회사 줄을 통째로 먹었다. 대문자 약어이면서
       * 그 줄이 법인 표기를 갖고 있으면 주소가 아니다.
       */
      if (m[0] === m[0].toUpperCase() && COMPANY_MARKERS.some((re) => re.test(l.text))) continue;
      push({ key: "website", value: m[0].replace(/[),.;]+$/, ""), normalized: norm, confidence: conf * 0.93, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }

    /*
     * 같은 자리에서 여러 정규식이 겹쳐 잡으면 좋은 쪽만 남긴다.
     *   ① 국내 표준꼴(0으로 시작)  ② 국제표기(+)  ③ 느슨한 꼴
     * 느슨한 꼴은 앞에 붙은 찌꺼기를 번호로 물기도 하고("H.P"→"10616" 이
     * "10616 010-9494" 가 된다) 뒤를 잘라 먹기도 한다(+44 7700 9001).
     * 같은 등급이면 숫자를 더 많이 담은 쪽을 고른다.
     */
    type Cand = { value: string; index: number; rank: number };
    const cands: Cand[] = [];
    const collect = (re: RegExp, rank: number) => {
      for (const m of l.text.matchAll(re)) cands.push({ value: m[0], index: m.index ?? 0, rank });
    };
    collect(KR_PHONE_RE, 3);
    collect(INTL_PHONE_RE, 2);
    collect(PHONE_RE, 1);
    cands.sort(
      (a, b) =>
        b.rank - a.rank ||
        b.value.replace(/\D/g, "").length - a.value.replace(/\D/g, "").length ||
        a.index - b.index,
    );
    const phones: Cand[] = [];
    for (const m of cands) {
      const overlaps = phones.some((p) => m.index < p.index + p.value.length && p.index < m.index + m.value.length);
      if (!overlaps) phones.push(m);
    }
    phones.sort((a, b) => a.index - b.index);

    for (const m of phones) {
      const raw = m.value.trim();
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 8) continue;
      /*
       * 라벨을 볼 때 나라번호 앞머리는 지운다 — "F.+82 032 549 9195" 에서 국내 꼴
       * "032 549 9195" 가 먼저 잡히면 라벨 앞이 "F.+82 " 가 되어 팩스 판정을 비켜 간다.
       */
      const before = l.text.slice(0, m.index).replace(/\+\d{1,3}[\s.()-]*$/, "");
      let key: FieldKey = "phone";
      let c = conf * 0.9;
      if (LABEL_FAX.test(before)) key = "fax";
      else if (LABEL_MOBILE.test(before)) key = "mobile";
      else if (LABEL_TEL.test(before)) key = "phone";
      else if (/^(?:\+?82[\s.-]?)?0?1[016789]/.test(raw.replace(/[()\s]/g, ""))) key = "mobile";
      else if (intlLooksMobile(raw)) key = "mobile";
      else {
        /*
         * 라벨도 없고 나라·지역 번호로 시작하지도 않는 여덟 자리는 번호의
         * 조각일 때가 많다 — 반사광이 "휴대폰 010-" 을 지워 "2020-6464" 만
         * 남은 장이 실제로 있었다. 반쪽 번호를 저장하면 사람이 지워야 한다.
         */
        if (digits.length === 8 && !/^[+01]/.test(raw)) continue;
        c = conf * 0.8; // 라벨 없는 유선번호
      }
      push({ key, value: raw, normalized: normalizePhone(raw), confidence: c, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      consumed = true;
    }
    if (consumed) used.add(i);
  });

  // Address (before company — addresses often include building names)
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text) return;
    const hits = ADDRESS_MARKERS.filter((re) => re.test(l.text)).length;
    if (hits >= 2 || (hits === 1 && /\d/.test(l.text) && l.text.length >= 10)) {
      push({ key: "address", value: l.text, normalized: null, confidence: lineConf(l) * (hits >= 2 ? 0.9 : 0.75), provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  /*
   * Company — 법인 표기가 있는 줄 가운데 **가장 큰 글씨**를 고른다.
   * 위에서부터 집으면 작게 찍힌 영문 병기("Accounting Corporation")가 상호
   * ("서율회계법인")를 밀어낸다. 글씨 크기를 모르면 위에 있는 줄을 쓴다.
   */
  if (!fields.some((f) => f.key === "company")) {
    const marked = clean
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => !used.has(i) && l.text)
      // 부서 줄("해외영업팀")은 회사가 먼저 집어가지 않게 비켜 둔다
      .filter(({ l }) => !DEPT_NOT_COMPANY.some((re) => re.test(l.text)))
      .filter(({ l }) => COMPANY_MARKERS.some((re) => re.test(l.text)))
      .sort((a, b) => bboxHeight(b.l) - bboxHeight(a.l) || a.i - b.i);
    const hit = marked[0];
    if (hit) {
      const value = stripMisreadCorp(hit.l.text);
      push({ key: "company", value, normalized: null, confidence: lineConf(hit.l) * (value === hit.l.text ? 0.9 : 0.8), provenance: "ocr", sourceLine: hit.i, bbox: hit.l.bbox });
      used.add(hit.i);
    }
  }
  // 꼬리말 없는 상호 + ㈜ 오읽음 — 위에서 아무 줄도 회사로 잡지 못했을 때만
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text || fields.some((f) => f.key === "company")) return;
    const rest = misreadCorpCompany(l.text);
    if (rest) {
      push({ key: "company", value: rest, normalized: null, confidence: lineConf(l) * 0.7, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  // Name + title (may share a line: "홍길동 대표" / "Jane Doe, CEO")
  let nameIdx = -1;
  const candidates = clean
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !used.has(i) && l.text.length > 0 && l.text.length <= 40);

  for (const { l, i } of candidates) {
    const title = hasTitleWord(l.text);
    if (!title) continue;
    const parts = l.text.split(/\s*[,|/·]\s*|\s{2,}/).filter(Boolean);
    let titleValue = l.text;
    let deptDone = false;
    if (parts.length >= 2) {
      /*
       * 직책 낱말은 이름 후보에서 뺀다. "임채원 / 해외영업팀 / 부장" 에서
       * '부장' 은 두 글자 한글이라 이름 조건을 통과해, 이름 칸에 직책이
       * 들어앉고 정작 이름이 버려졌다(실제 사진에서 나온 오류).
       */
      const namePart = parts.find((p) => !hasTitleWord(p) && looksLikeAnyName(p));
      if (namePart && nameIdx < 0) {
        push({ key: "fullName", value: namePart, normalized: normalizePersonName(namePart), confidence: lineConf(l) * 0.85, provenance: "ocr", sourceLine: i, bbox: l.bbox });
        nameIdx = i;
        // Rule 6: the title must be a literal slice of the line — never re-join separated parts
        // ("Jane Doe, CEO, Founder" → "CEO, Founder", not "CEO Founder").
        const rest = parts.filter((p) => p !== namePart);
        const deptPart = rest.length >= 2 ? rest.find((p) => !hasTitleWord(p) && DEPT_MARKERS.some((re) => re.test(p))) : undefined;
        if (deptPart) {
          push({ key: "department", value: deptPart, normalized: null, confidence: lineConf(l) * 0.75, provenance: "ocr", sourceLine: i, bbox: l.bbox });
          deptDone = true;
        }
        const titleParts = rest.filter((p) => p !== deptPart);
        titleValue = sliceSpanning(l.text, titleParts) ?? titleParts[0] ?? l.text;
      }
    }
    if (!deptDone && titleValue === l.text) {
      /*
       * 한 줄에 이름·부서·직책이 함께 찍힌 줄을 낱말 단위로 가른다. 실제
       * 명함에서 나오는 꼴이 제각각이라 정규식 하나로는 안 된다.
       *
       *   "임채원 해외영업팀/ 부장"   "황 도윤 영업2팀 과장"
       *   "구매팀 차장"              "영업 본부 이사"       "홍길동 대표이사"
       *
       * 뒤에서부터 직책 낱말을 찾고, 그 앞에서 부서 꼬리말을 찾고, 남은 앞머리를
       * 이름으로 본다. 저장하는 값은 원문 조각 그대로다 — 지어내지 않는다.
       */
      const toks = l.text.split(/\s*[,|/·]\s*|\s+/).filter(Boolean);
      const titleAt = toks.findIndex((t) => hasTitleWord(t));
      /*
       * 직책을 이름보다 **먼저** 찍는 명함도 있다("이사 최원석"). 앞머리를 이름으로
       * 보는 아래 흐름은 그 꼴을 통째로 직책 칸에 넣어 버린다.
       */
      if (titleAt === 0 && nameIdx < 0 && toks.length >= 2) {
        /*
         * 직책 낱말은 후보에서 뺀다 — "Director/대표이사" 의 '대표이사' 는 네 글자
         * 한글이라 이름 조건을 통과해, 직책이 이름 칸에 들어앉는다(실제로 걸렸다).
         * 이름은 한글 한 토막, 한자 한 토막, 또는 로마자 두 토막("Director Jane Doe")으로 온다.
         */
        let nameFrom = -1;
        let nameEnd = -1;
        for (let k = 1; k < toks.length; k++) {
          if (hasTitleWord(toks[k]!)) continue;
          if (looksLikePersonNameStrict(toks[k]!) || looksLikeCjkName(toks[k]!)) { nameFrom = k; nameEnd = k + 1; break; }
          // 로마자 쌍은 둘째 토막도 직책이면 안 된다 — "Chief Operating Officer" 의 'Operating Officer'
          // 를 이름으로 지어내면 규칙6 위반이다(looksLikeLatinName 은 직책 낱말을 못 거른다).
          if (k + 1 < toks.length && !hasTitleWord(toks[k + 1]!) && looksLikeLatinName(`${toks[k]} ${toks[k + 1]}`)) { nameFrom = k; nameEnd = k + 2; break; }
        }
        if (nameFrom > 0) {
          const nameToks = toks.slice(nameFrom, nameEnd);
          const nameValue = sliceSpanning(l.text, nameToks) ?? nameToks[0]!;
          push({ key: "fullName", value: nameValue, normalized: normalizePersonName(nameValue), confidence: lineConf(l) * 0.8, provenance: "ocr", sourceLine: i, bbox: l.bbox });
          nameIdx = i;
          /*
           * 이름 뒤 토막에서 부서 꼬리말을 가른다(한글/한자만 — 영어는 'Team Leader' 가 직책의 일부).
           * "이사 최원석 영업팀" 에서 '영업팀' 을 부서로 뺀다. 예전에는 이름만 빼고 줄 전체를
           * 직책으로 삼아(sliceSpanning 이 이름을 가운데 끼고 줄을 덮었다) 부서가 유실됐다.
           */
          const after = toks.slice(nameEnd);
          const dAt = after.findIndex((t) => /[가-힣一-鿿぀-ヿ]/.test(t) && DEPT_MARKERS.some((re) => re.test(t)));
          if (dAt >= 0 && !deptDone) {
            const head = after.slice(0, dAt);
            const deptToks = head.length && DEPT_MARKERS.some((re) => re.test(head.join("") + after[dAt]!)) ? [...head, after[dAt]!] : [after[dAt]!];
            push({ key: "department", value: sliceSpanning(l.text, deptToks) ?? after[dAt]!, normalized: null, confidence: lineConf(l) * 0.75, provenance: "ocr", sourceLine: i, bbox: l.bbox });
            deptDone = true;
          }
          // 직책은 이름 앞 토막("이사" · "Director")만 — 연속 구간이라 원문 부분문자열로 남는다(규칙6).
          titleValue = sliceSpanning(l.text, toks.slice(0, nameFrom)) ?? toks[0]!;
        }
      }
      if (titleAt > 0) {
        /*
         * 이름을 **먼저** 가른다. 부서를 먼저 찾으면 '김부' 처럼 부서 꼬리말로
         * 끝나는 성명을 부서로 뺏긴다. 앞 토큰을 길게 잡는 쪽부터 본다.
         */
        let nameEnd = 0;
        let nameFrom = 0;
        if (nameIdx < 0) {
          for (let n = Math.min(3, titleAt); n >= 1; n--) {
            const cand = toks.slice(0, n);
            const glued = cand.join("");
            /*
             * 앞머리가 '다른 줄에 있는 더 긴 이름의 조각' 이면 쓰지 않는다 —
             * "남기훈" 과 "기훈 부장" 이 함께 나오면 '기훈' 이 성씨로 시작해
             * 사람 이름 판정을 통과해 버린다. 긴 쪽을 쓰도록 여기서는 비운다.
             */
            const isFragment = /^[가-힣]{2,3}$/.test(glued) && candidates.some(
              (y) => y.i !== i && !used.has(y.i) && y.l.text.length > glued.length &&
                     y.l.text.includes(glued) && looksLikeKoreanName(y.l.text),
            );
            if (glued.length <= 4 && looksLikePersonNameStrict(glued) && !isFragment) { nameEnd = n; break; }
            if (n <= 2 && looksLikeLatinName(cand.join(" "))) { nameEnd = n; break; }
          }
          /*
           * 앞머리가 이름이 아니면, 직책 앞 토큰 가운데 이름인 것을 찾는다 —
           * 로마자 이름을 먼저 찍는 명함이 흔하다("S.K.Leem | 임승관 부장").
           * 앞에서 못 가르면 줄 전체가 직책 칸에 들어앉는다.
           */
          if (nameEnd === 0) {
            for (let k = 1; k < titleAt; k++) {
              if (looksLikePersonNameStrict(toks[k]!)) { nameFrom = k; nameEnd = k + 1; break; }
            }
          }
        }
        if (nameEnd > 0) {
          const nameToks = toks.slice(nameFrom, nameEnd);
          const nameValue = sliceSpanning(l.text, nameToks) ?? nameToks[0]!;
          push({ key: "fullName", value: nameValue, normalized: normalizePersonName(nameValue), confidence: lineConf(l) * 0.8, provenance: "ocr", sourceLine: i, bbox: l.bbox });
          nameIdx = i;
        }
        let deptAt = -1;
        for (let d = nameEnd; d < titleAt; d++) {
          // 한글/한자일 때만 — 영어는 "Team Leader" 처럼 부서 낱말이 직책 이름의 일부다
          if (!/[가-힣一-鿿぀-ヿ]/.test(toks[d]!)) continue;
          if (DEPT_MARKERS.some((re) => re.test(toks[d]!))) { deptAt = d; break; }
        }
        if (deptAt >= 0) {
          // 이름을 못 가른 앞머리는 '영업'+'본부' 처럼 부서가 끊긴 것으로 본다
          const head = toks.slice(nameEnd, deptAt);
          const deptToks =
            head.length && DEPT_MARKERS.some((re) => re.test(head.join("") + toks[deptAt]!))
              ? [...head, toks[deptAt]!]
              : [toks[deptAt]!];
          push({ key: "department", value: sliceSpanning(l.text, deptToks) ?? toks[deptAt]!, normalized: null, confidence: lineConf(l) * 0.75, provenance: "ocr", sourceLine: i, bbox: l.bbox });
          deptDone = true;
        }
        /*
         * 부서가 직책 **뒤에** 오는 줄 — "Sales Senior | 서초 전시장 영업팀".
         * 앞쪽만 보면 못 찾고, 그 줄은 '쓴 줄' 로 표시되어 뒤의 부서 패스도 못 본다.
         * 직책 다음 토큰부터 꼬리말이 나오는 데까지를 통째로 부서로 본다.
         */
        if (deptAt < 0 && nameEnd === 0 && !fields.some((f) => f.key === "department")) {
          let tailAt = -1;
          for (let d = titleAt + 1; d < toks.length; d++) {
            if (!/[가-힣一-鿿぀-ヿ]/.test(toks[d]!)) continue;
            if (DEPT_MARKERS.some((re) => re.test(toks[d]!))) { tailAt = d; break; }
          }
          if (tailAt > titleAt) {
            const deptToks = toks.slice(titleAt + 1, tailAt + 1);
            push({ key: "department", value: sliceSpanning(l.text, deptToks) ?? toks[tailAt]!, normalized: null, confidence: lineConf(l) * 0.7, provenance: "ocr", sourceLine: i, bbox: l.bbox });
            deptDone = true;
            // 직책은 부서를 뺀 앞쪽이다 ("Sales Senior")
            titleValue = sliceSpanning(l.text, toks.slice(0, titleAt + 1)) ?? titleValue;
          }
        }
        /*
         * 직책은 이름·부서를 뺀 나머지 전부("Sales Director" 처럼 두 낱말도 있다).
         * 다만 앞머리가 다른 줄에 있는 이름의 조각이면("남기훈" 과 "기훈 부장")
         * 직책에 붙이지 않는다 — OCR 이 이름 줄을 두 번 뱉을 때 나온다.
         */
        let titleFrom: number = deptAt >= 0 ? deptAt + 1 : nameEnd;
        if (deptAt < 0 && nameEnd === 0 && toks.length >= 2 && /^[가-힣]{2,3}$/.test(toks[0]!)) {
          const frag = toks[0]!;
          const isFragment = candidates.some(
            (y) => y.i !== i && !used.has(y.i) && y.l.text.length > frag.length && y.l.text.includes(frag) && looksLikeKoreanName(y.l.text),
          );
          if (isFragment) titleFrom = 1;
        }
        /*
         * 직책 앞에 숫자가 섞인 토큰이 남으면 부서가 깨져 읽힌 것이다 —
         * "영업3팀" 이 "영업36" 으로 읽혀 꼬리말을 잃으면 직책에 붙어
         * "영업36 팀장" 이 된다. 직책 칸에는 넣지 않는다.
         */
        while (titleFrom < titleAt && /\d/.test(toks[titleFrom]!)) titleFrom++;
        const titleToks = toks.slice(titleFrom);
        if (titleToks.length) titleValue = sliceSpanning(l.text, titleToks) ?? titleValue;
      }
    }
    /*
     * 첫 낱말이 부서 꼬리말이면 떼어 낸다 — 다만 한글/한자일 때만이다.
     * 영어는 "Team Leader"·"Group Lead" 처럼 부서 낱말이 직책 이름의 일부로 쓰여,
     * 떼어 내면 직책이 "Leader" 로 깎이고 부서 칸에 "Team" 이 들어앉는다.
     */
    const deptHead = titleValue.split(" ")[0] ?? "";
    const deptMatch = !deptDone && /[가-힣一-鿿぀-ヿ]/.test(deptHead) && DEPT_MARKERS.some((re) => re.test(deptHead));
    if (deptMatch && titleValue.includes(" ")) {
      const [dept, ...rest] = titleValue.split(" ");
      push({ key: "department", value: dept!, normalized: null, confidence: lineConf(l) * 0.75, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      titleValue = rest.join(" ");
    }
    if (!fields.some((f) => f.key === "jobTitle")) {
      push({ key: "jobTitle", value: titleValue, normalized: null, confidence: lineConf(l) * 0.85, provenance: "ocr", sourceLine: i, bbox: l.bbox });
    }
    used.add(i);
  }

  if (nameIdx < 0) {
    /*
     * 한글 이름 뒤에 로마자 표기를 붙여 찍은 줄("이수진ISU JIN LEE")은 줄 전체로는
     * 이름처럼 보이지 않아 통째로 버려지거나 부서 칸에 들어간다. 앞머리 한글만 쓴다.
     */
    const korPrefix = (t: string) => {
      const m = /^([가-힣]{2,4})(?=[A-Za-z])/.exec(t.trim());
      return m && looksLikePersonNameStrict(m[1]!) ? m[1]! : null;
    };
    /*
     * 이름 줄에 로마자 표기를 구분자로 붙여 찍는 명함이 흔하다("이수진 | SU JIN LEE").
     * 줄 전체로는 이름처럼 보이지 않으므로 토막으로 갈라 한 쪽만 본다.
     */
    const partName = (t: string) => {
      const parts = t.split(/\s*[|｜/·,]\s*/).map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) return null;
      return parts.find((p) => !hasTitleWord(p) && looksLikePersonNameStrict(p)) ?? null;
    };
    let nameCands = candidates
      .filter(({ i }) => !used.has(i))
      .map((x) => ({ ...x, pick: looksLikeAnyName(x.l.text) ? x.l.text : (korPrefix(x.l.text) ?? partName(x.l.text)) }))
      .filter((x): x is typeof x & { pick: string } => !!x.pick);
    /*
     * OCR 이 같은 이름 줄을 두 번 뱉으면서 한 번은 앞 글자를 흘린다 —
     * "선우재현" 과 "우재현" 이 함께 나온다. 짧은 쪽은 긴 쪽의 조각이므로 버린다.
     */
    const all = nameCands;
    nameCands = nameCands.filter(({ pick }) => {
      const t = normalizePersonName(pick);
      return !all.some(({ pick: o }) => {
        const u = normalizePersonName(o);
        return u.length > t.length && u.includes(t);
      });
    });
    /*
     * 고르는 차례 — ① 성씨로 시작하는 쪽 ② 큰 글씨 ③ 위에 있는 줄.
     * ①이 없으면 '준오헤어' 같은 네 글자 상호가 이름으로 뽑힌다. 거르는 것이
     * 아니라 차례만 매기므로, 성씨 목록에 없는 이름도 다른 후보가 없으면 뽑힌다.
     */
    const startsWithSurname = (t: string) => (SURNAMES.has(normalizePersonName(t).charAt(0)) ? 1 : 0);
    /*
     * 직책 줄 바로 옆에 있는 쪽을 먼저 본다 — 이름과 직책은 붙여 찍는다.
     * "차돌삼합 진대감 / 선릉점 / 대표 / 박제인" 에서 '선릉점'(지점 이름)이 먼저
     * 나온다는 이유만으로 이름이 됐다. 직책('대표') 옆은 '박제인' 이다.
     */
    const titleLine = fields.find((f) => f.key === "jobTitle")?.sourceLine ?? -1;
    const nextToTitle = (i: number) => (titleLine >= 0 && Math.abs(i - titleLine) === 1 ? 1 : 0);
    nameCands.sort(
      (a, b) =>
        startsWithSurname(b.pick) - startsWithSurname(a.pick) ||
        nextToTitle(b.i) - nextToTitle(a.i) ||
        bboxHeight(b.l) - bboxHeight(a.l) ||
        a.i - b.i,
    );
    const chosen = nameCands[0];
    if (chosen) {
      const korean = looksLikeKoreanName(chosen.pick);
      push({
        key: "fullName",
        value: chosen.pick,
        normalized: normalizePersonName(chosen.pick),
        confidence: lineConf(chosen.l) * (korean ? 0.85 : 0.7) * (nameCands.length > 1 ? 0.85 : 1),
        provenance: "ocr",
        sourceLine: chosen.i,
        bbox: chosen.l.bbox,
      });
      used.add(chosen.i);
    }
  }

  // Department lines without a title word
  clean.forEach((l, i) => {
    if (used.has(i) || !l.text || fields.some((f) => f.key === "department")) return;
    if (l.text.length <= 30 && DEPT_MARKERS.some((re) => re.test(l.text))) {
      push({ key: "department", value: l.text, normalized: null, confidence: lineConf(l) * 0.65, provenance: "ocr", sourceLine: i, bbox: l.bbox });
      used.add(i);
    }
  });

  /*
   * 회사 줄을 아직 못 찾았으면 '맨 위에 남은 줄' 을 회사로 본다.
   *
   * 업종 꼬리말 목록은 아무리 늘려도 샌다 — '오가닉스킨랩'·'가람디자인' 처럼
   * 새로 짓는 상호가 끝이 없다. 처음 보는 명함 묶음에서 회사 줄을 놓친 10장이
   * 전부 이 꼴이었다. 사람도 이렇게 읽는다: 이름도 부서도 직책도 연락처도
   * 주소도 아닌데 맨 위에 크게 찍혀 있으면 회사다. 확신은 낮게 매긴다.
   */
  if (!fields.some((f) => f.key === "company")) {
    const haveName = fields.some((f) => f.key === "fullName");
    const pool: { i: number; l: (typeof clean)[number] }[] = [];
    for (let ci = 0; ci < clean.length; ci++) {
      const cl = clean[ci]!;
      if (used.has(ci) || !cl.text) continue;
      const ct = cl.text;
      // 한글·한자 상호는 두 글자짜리가 흔하다("율암"). 로마자는 두 글자면 거의 찌꺼기다.
      const cjkOnly = /^[가-힣一-鿿぀-ヿ\s()]+$/.test(ct);
      if (ct.length < (cjkOnly ? 2 : 3) || ct.length > 40) continue;
      if ((ct.match(/[\p{L}]/gu) ?? []).length < (cjkOnly ? 2 : 3)) continue;   // 글자가 거의 없는 찌꺼기
      if ((ct.match(/\d/g) ?? []).length >= 3) continue;        // 번호가 남은 줄
      if (hasTitleWord(ct)) continue;
      // 이름 줄을 아직 못 찾았으면 이름처럼 보이는 줄은 건드리지 않는다
      if (!haveName && looksLikeAnyName(ct)) continue;
      /*
       * 이름을 찾았다면, 로마자 사람 이름 꼴은 그 이름의 병기다 — 회사가 아니다.
       * 한글 이름 옆에 로마자 표기를 따로 찍는 명함이 흔해서("윤종석" / "JONGSEOK YOON"),
       * '이름 옆 줄' 우선 규칙과 겹치면 로마자 표기가 회사 칸에 들어앉는다.
       * 한글 쪽은 거르지 않는다 — '암웨이' 처럼 세 글자 상호가 이름 꼴과 똑같다.
       */
      if (haveName && looksLikeLatinName(ct)) continue;
      if (DEPT_MARKERS.some((re) => re.test(ct))) continue;
      if (ADDRESS_MARKERS.some((re) => re.test(ct))) continue;
      // 찌꺼기 줄을 회사로 앉히지 않으려는 세 가지 (실제로 걸린 것들이다)
      if (lineConf(cl) < 0.7) continue;
      if (/[|｜]/.test(ct)) continue;
      if (PARTICLE_TAIL.test(ct)) continue;                     // 문구의 조각 ("건강컨설팅의")
      if (!/[가-힣一-鿿぀-ヿ]/.test(ct) && !/^[A-Z0-9]/.test(ct)) continue;
      pool.push({ i: ci, l: cl });
    }
    /*
     * 고르는 차례 — ① 이름 줄 바로 옆 ② 가장 큰 글씨 ③ 맨 위.
     *
     * ①은 "이름 다음 줄에 소속" 이라는 흔한 배치다. 이게 없으면 "BNI PROMISE"
     * (모임 이름)처럼 맨 위에 찍힌 줄이 회사가 되고, 정작 이름 밑의 '암웨이' 가 남는다.
     * ②는 상호를 크게 찍는 배치를 잡는다("AI 프로그램 개발" 같은 설명 줄이 아니라).
     * 글씨 크기를 모르는 엔진(상자 없음)에서는 ①과 ③만으로 고른다.
     */
    const nameLine = fields.find((f) => f.key === "fullName")?.sourceLine ?? -1;
    const nextToName = (i: number) => (nameLine >= 0 && Math.abs(i - nameLine) === 1 ? 1 : 0);
    pool.sort((a, b) => nextToName(b.i) - nextToName(a.i) || bboxHeight(b.l) - bboxHeight(a.l) || a.i - b.i);
    const co = pool[0];
    if (co) {
      push({ key: "company", value: co.l.text, normalized: null, confidence: lineConf(co.l) * 0.6, provenance: "ocr", sourceLine: co.i, bbox: co.l.bbox });
      used.add(co.i);
    }
  }

  /*
   * 부서는 꼬리말이 있을 때만 잡는다(위의 DEPT_MARKERS 통과분).
   *
   * 예전에는 "남은 짧은 줄" 을 부서로 보는 갈래가 있었다 — 꼬리말을 안 쓰는 영문 부서
   * ("Global Sourcing") 를 잡으려던 것이다. 실제로 찍은 명함 13장으로 재 보니 그 갈래가
   * 아홉 장에서 틀렸다: 태그라인("Medical Community", "Audit·Tax·Advisory"),
   * 로마자 이름("CHOI YOUNG JU"), 한자 상호(世全綜合建設株式會社), 모임 이름
   * ("BNI. PROMISE"), 심지어 사람 이름까지 부서 칸에 들어앉았다.
   *
   * 명함에는 부서가 없는 쪽이 오히려 흔하다. 틀린 부서는 빈 부서보다 나쁘다 —
   * 연락처에 그대로 박히고 사람이 지워야 한다. 그래서 추측을 그만둔다.
   */

  const unassigned = clean.map((l, i) => ({ line: i, text: l.text })).filter((x) => x.text && !used.has(x.line));
  return { fields, unassigned, language: detectLanguage(clean.map((l) => l.text).join(" ")) };
}

export function needsReview(f: Pick<ExtractedField, "confidence">): boolean {
  return f.confidence < REVIEW_THRESHOLD;
}

/** Collapse extracted fields into a flat draft (first value per key wins). */
export function toDraft(fields: ExtractedField[]): Partial<Record<FieldKey, string>> {
  const d: Partial<Record<FieldKey, string>> = {};
  for (const f of fields) if (d[f.key] === undefined) d[f.key] = f.value;
  return d;
}

/**
 * Verify the no-fabrication invariant: every value must be a substring of its source line
 * after `tidyOcrText` — the same text the parser classified. tidyOcrText only deletes and
 * joins characters, so a value grounded in the tidied line is still grounded in the photo.
 */
export function assertGrounded(fields: ExtractedField[], lines: OcrLine[]): void {
  for (const f of fields) {
    if (f.provenance !== "ocr") continue;
    const src = tidyOcrText(lines[f.sourceLine]?.text);
    if (!src.includes(f.value)) throw new Error(`ungrounded field ${f.key}`);
  }
}
