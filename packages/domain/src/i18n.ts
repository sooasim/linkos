// F-177 다국어 — ko/en 우선(+ja), 리소스 분리 구조. 순수 함수: 로케일 선택 + 메시지 보간.
// 게스트 수신 화면은 상대가 외국인일 수 있으므로 Accept-Language 를 따른다(가입 전에도 이해 가능해야 교환이 먼저 일어난다).

export const LOCALES = ["ko", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

const isLocale = (v: string): v is Locale => (LOCALES as readonly string[]).includes(v);

/** Pick a supported locale: explicit override (cookie/query) wins, then Accept-Language by q-value, else ko. */
export function pickLocale(acceptLanguage: string | null | undefined, override?: string | null): Locale {
  const o = override?.trim().toLowerCase().slice(0, 2);
  if (o && isLocale(o)) return o;
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .slice(0, 20)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const qp = params.find((p) => p.trim().startsWith("q="));
      const q = qp ? Number(qp.trim().slice(2)) : 1;
      return { lang: (tag ?? "").trim().toLowerCase().split("-")[0] ?? "", q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) if (isLocale(r.lang)) return r.lang;
  return DEFAULT_LOCALE;
}

/** "{name}님" + {name:"Jun"} → "Jun님". Unknown keys are left as-is (never throws). */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

const ko = {
  back: "뒤로",
  arrivedAt: "{place}에서 · 명함이 도착했어요",
  arrived: "명함이 도착했어요",
  senderCard: "{name}님의",
  alreadyExchanged: "이 링크로는 이미 교환이 완료되었어요. 카드는 계속 볼 수 있습니다.",
  captureTitle: "내 명함을",
  captureEm: "찍어주세요",
  captureBody: "가입 없이 {name}님께 바로 보낼 수 있어요. 10초면 충분합니다.",
  reviewEyebrowSigned: "내 명함으로 교환",
  reviewTitle: "보낼 내용을",
  reviewEm: "확인",
  reviewBody: "체크한 항목만 {name}님에게 전달됩니다.",
  extraSummary: "한 줄 메시지 · Offer/Need (선택)",
  messagePh: "{name}님께 남길 한마디",
  offerPh: "내가 줄 수 있는 것 (Offer)",
  needPh: "지금 필요한 것 (Need)",
  consentA: "선택한 항목을",
  consentB: "님에게 보내는 데 동의합니다. 교환 기록은",
  privacy: "개인정보 처리방침",
  consentC: "에 따라 보관됩니다.",
  doneTitle: "교환",
  doneEm: "완료",
  doneBody: "{name}님에게 내 명함이 전달됐어요.",
  nextStep: "다음 단계 · 선택",
  claimTitle: "방금 만든 내 디지털 명함을 소유하시겠어요?",
  claimBody: "가입하면 {name}님 명함이 내 주소록에 저장되고, 방금 입력한 정보로 Living Card가 자동 완성됩니다.",
  claimCta: "내 카드 소유하기",
  openNetwork: "내 인맥에서 보기",
  replyCta: "내 명함도 보내기",
  replyCtaFast: "10초 만에 내 명함 보내기",
  pickFromContacts: "내 연락처에서 불러오기",
  pickFilled: "연락처에서 채웠어요. 보내기 전에 확인하세요.",
  pickFailed: "연락처를 불러오지 못했어요. 직접 입력해 주세요.",
  startLinkos: "나도 LINKOS 시작하기",
  sending: "보내는 중…",
  sendTo: "{name}님께 보내기",
  footSigned: "로그인 상태 — 양쪽 주소록에 바로 저장돼요",
  footGuest: "가입 없이 교환 · 언제든 삭제 요청 가능",
  language: "언어",
  linkExpiredT: "링크가 만료됐어요",
  linkExpiredB: "교환 링크는 보안을 위해 잠시만 유효합니다. 상대에게 새 링크나 코드를 요청하세요.",
  linkRevokedT: "교환이 취소됐어요",
  linkRevokedB: "보낸 사람이 이 교환을 취소했습니다.",
  notFoundT: "링크를 찾을 수 없어요",
  notFoundB: "주소나 코드를 다시 확인해 주세요.",
  rateLimitedT: "잠시 후 다시 시도하세요",
  rateLimitedB: "짧은 시간에 너무 많은 요청이 있었습니다.",
  errorT: "문제가 생겼어요",
  errorB: "잠시 후 다시 시도해 주세요.",
  networkError: "인터넷에 연결되어 있지 않아요. 연결을 확인한 뒤 다시 보내 주세요.",
  receiveByCode: "코드로 받기",
  learnMore: "LINKOS 알아보기",
};
export type GuestMessages = typeof ko;

const en: GuestMessages = {
  back: "Back",
  arrivedAt: "At {place} · A card for you",
  arrived: "A card for you",
  senderCard: "{name}'s",
  alreadyExchanged: "This link has already been used for an exchange. You can still view the card.",
  captureTitle: "Snap your",
  captureEm: "business card",
  captureBody: "Send it to {name} without signing up. It takes about 10 seconds.",
  reviewEyebrowSigned: "Exchange with my card",
  reviewTitle: "Review what you",
  reviewEm: "share",
  reviewBody: "Only the checked fields are sent to {name}.",
  extraSummary: "Message · Offer/Need (optional)",
  messagePh: "A short note for {name}",
  offerPh: "What I can offer",
  needPh: "What I need right now",
  consentA: "I agree to send the selected fields to",
  consentB: ". The exchange record is kept according to the",
  privacy: "Privacy Policy",
  consentC: ".",
  doneTitle: "Exchange",
  doneEm: "complete",
  doneBody: "Your card has been delivered to {name}.",
  nextStep: "Next · optional",
  claimTitle: "Keep the digital card you just made?",
  claimBody: "Sign up to save {name}'s card to your contacts and auto-fill your Living Card from what you entered.",
  claimCta: "Claim my card",
  openNetwork: "Open in my network",
  replyCta: "Send my card back",
  replyCtaFast: "Send my card in 10 seconds",
  pickFromContacts: "Fill from my contacts",
  pickFilled: "Filled from your contacts. Please review before sending.",
  pickFailed: "Couldn't load contacts. Please enter them manually.",
  startLinkos: "Start with LINKOS",
  sending: "Sending…",
  sendTo: "Send to {name}",
  footSigned: "Signed in — saved to both contact lists instantly",
  footGuest: "No sign-up needed · Request deletion anytime",
  language: "Language",
  linkExpiredT: "This link has expired",
  linkExpiredB: "Exchange links are valid only briefly for security. Ask for a new link or code.",
  linkRevokedT: "Exchange cancelled",
  linkRevokedB: "The sender cancelled this exchange.",
  notFoundT: "Link not found",
  notFoundB: "Please check the address or code again.",
  rateLimitedT: "Please try again shortly",
  rateLimitedB: "Too many requests in a short time.",
  errorT: "Something went wrong",
  errorB: "Please try again in a moment.",
  networkError: "You're offline. Check your connection and send again.",
  receiveByCode: "Receive by code",
  learnMore: "About LINKOS",
};

const ja: GuestMessages = {
  back: "戻る",
  arrivedAt: "{place}で · 名刺が届きました",
  arrived: "名刺が届きました",
  senderCard: "{name}さんの",
  alreadyExchanged: "このリンクでは交換がすでに完了しています。名刺は引き続き閲覧できます。",
  captureTitle: "あなたの名刺を",
  captureEm: "撮影",
  captureBody: "登録なしで{name}さんにすぐ送れます。10秒で完了します。",
  reviewEyebrowSigned: "自分の名刺で交換",
  reviewTitle: "送る内容を",
  reviewEm: "確認",
  reviewBody: "チェックした項目だけが{name}さんに送られます。",
  extraSummary: "ひとことメッセージ · Offer/Need（任意）",
  messagePh: "{name}さんへのひとこと",
  offerPh: "提供できること（Offer）",
  needPh: "いま必要なこと（Need）",
  consentA: "選択した項目を",
  consentB: "さんに送ることに同意します。交換記録は",
  privacy: "プライバシーポリシー",
  consentC: "に従って保管されます。",
  doneTitle: "交換",
  doneEm: "完了",
  doneBody: "{name}さんにあなたの名刺が届きました。",
  nextStep: "次のステップ · 任意",
  claimTitle: "作成したデジタル名刺を保存しますか？",
  claimBody: "登録すると{name}さんの名刺が連絡先に保存され、入力した情報で Living Card が自動作成されます。",
  claimCta: "自分の名刺を保存",
  openNetwork: "人脈で見る",
  replyCta: "自分の名刺も送る",
  replyCtaFast: "10秒で自分の名刺を送る",
  pickFromContacts: "連絡先から読み込む",
  pickFilled: "連絡先から入力しました。送信前に確認してください。",
  pickFailed: "連絡先を読み込めませんでした。手入力してください。",
  startLinkos: "LINKOS をはじめる",
  sending: "送信中…",
  sendTo: "{name}さんに送る",
  footSigned: "ログイン中 — 双方の連絡先にすぐ保存されます",
  footGuest: "登録不要で交換 · いつでも削除依頼可能",
  language: "言語",
  linkExpiredT: "リンクの有効期限が切れました",
  linkExpiredB: "交換リンクはセキュリティのため短時間のみ有効です。新しいリンクかコードを依頼してください。",
  linkRevokedT: "交換は取り消されました",
  linkRevokedB: "送信者がこの交換を取り消しました。",
  notFoundT: "リンクが見つかりません",
  notFoundB: "アドレスまたはコードを確認してください。",
  rateLimitedT: "しばらくしてからお試しください",
  rateLimitedB: "短時間にリクエストが多すぎます。",
  errorT: "問題が発生しました",
  errorB: "しばらくしてから再度お試しください。",
  networkError: "インターネットに接続されていません。接続を確認してもう一度送信してください。",
  receiveByCode: "コードで受け取る",
  learnMore: "LINKOS について",
};

export const GUEST_MESSAGES: Record<Locale, GuestMessages> = { ko, en, ja };

// Card scanner (shared component). The guest landing is shown to foreign recipients before signup (F-177), so the
// capture step must follow the negotiated locale too — not only the landing copy around it.
const scannerKo = {
  findingEdges: "테두리 찾는 중",
  perspectiveDone: "원근 보정 완료",
  enhancing: "이미지 보정 중",
  readFailedCard: "글자를 읽지 못했어요. 밝은 곳에서 명함이 화면을 가득 채우도록 다시 촬영하거나 직접 입력하세요.",
  readFailedBadge: "배지 글자를 읽지 못했어요. 이름이 잘 보이도록 가까이에서 다시 촬영하거나 직접 입력하세요.",
  nounCard: "종이 명함",
  nounBadge: "행사 배지",
  pickPhoto: "{noun} 사진 선택",
  captured: "촬영한 {noun}",
  retake: "다시 촬영",
  shoot: "{noun} 촬영",
  hint: "테두리·기울기는 자동으로 보정되고, 사진은 이 기기에서만 분석됩니다",
  corrected: "테두리를 찾아 원근·기울기를 보정했어요",
  notCorrected: "테두리를 찾지 못해 원본 그대로 인식했어요",
  ocrLanguage: "인식 언어",
  autoFix: "자동 보정",
  on: "켜짐",
  off: "꺼짐",
  manual: "직접 입력할게요",
};
export type ScannerMessages = typeof scannerKo;
export const SCANNER_MESSAGES: Record<Locale, ScannerMessages> = {
  ko: scannerKo,
  en: {
    findingEdges: "Finding the card edges",
    perspectiveDone: "Perspective corrected",
    enhancing: "Enhancing the image",
    readFailedCard: "We couldn't read the text. Retake the photo in good light with the card filling the screen, or enter it manually.",
    readFailedBadge: "We couldn't read the badge. Move closer so the name is clearly visible, or enter it manually.",
    nounCard: "business card",
    nounBadge: "event badge",
    pickPhoto: "Choose a {noun} photo",
    captured: "Captured {noun}",
    retake: "Retake",
    shoot: "Scan {noun}",
    hint: "Edges and tilt are corrected automatically; the photo is analyzed only on this device",
    corrected: "Found the edges and corrected perspective and tilt",
    notCorrected: "No edges found — recognized the original photo",
    ocrLanguage: "Recognition language",
    autoFix: "Auto-correct",
    on: "on",
    off: "off",
    manual: "Enter it manually",
  },
  ja: {
    findingEdges: "輪郭を検出中",
    perspectiveDone: "遠近補正完了",
    enhancing: "画像を補正中",
    readFailedCard: "文字を読み取れませんでした。明るい場所で名刺が画面いっぱいになるよう撮り直すか、手入力してください。",
    readFailedBadge: "バッジの文字を読み取れませんでした。名前がはっきり見えるよう近づいて撮り直すか、手入力してください。",
    nounCard: "名刺",
    nounBadge: "イベントバッジ",
    pickPhoto: "{noun}の写真を選択",
    captured: "撮影した{noun}",
    retake: "撮り直す",
    shoot: "{noun}を撮影",
    hint: "輪郭と傾きは自動で補正され、写真はこの端末内だけで解析されます",
    corrected: "輪郭を検出して遠近と傾きを補正しました",
    notCorrected: "輪郭が見つからないため元の写真で認識しました",
    ocrLanguage: "認識言語",
    autoFix: "自動補正",
    on: "オン",
    off: "オフ",
    manual: "手入力する",
  },
};
export const LOCALE_NAMES: Record<Locale, string> = { ko: "한국어", en: "English", ja: "日本語" };

// Living Card labels (shared card component; guest landing passes the negotiated locale)
export const CARD_MESSAGES = {
  "ko": {
    "tabDepth": "카드 깊이",
    "tab3": "3초",
    "tab30": "30초",
    "tabDeep": "딥 프로필",
    "noFields": "공개된 연락처가 없습니다.",
    "noDeep": "아직 공개된 딥 프로필이 없습니다.",
    "hidden": "비공개 항목 {n}개 — 연결 후 공유 요청 가능",
    "saveVcard": "연락처에 저장 (vCard)",
    "offer": "Offer · 줄 수 있는 것",
    "need": "Need · 지금 필요한 것",
    "projects": "프로젝트",
    "achievements": "성과",
    "services": "서비스",
    "assets": "보유 자원",
    "network": "네트워크",
    "interests": "관심 분야",
    "languages": "언어",
    "certifications": "인증"
  },
  "en": {
    "tabDepth": "Card depth",
    "tab3": "3 sec",
    "tab30": "30 sec",
    "tabDeep": "Deep profile",
    "noFields": "No public contact details.",
    "noDeep": "No deep profile shared yet.",
    "hidden": "{n} private fields — request access after connecting",
    "saveVcard": "Save to contacts (vCard)",
    "offer": "Offer · What I can give",
    "need": "Need · What I need now",
    "projects": "Projects",
    "achievements": "Achievements",
    "services": "Services",
    "assets": "Resources",
    "network": "Network",
    "interests": "Interests",
    "languages": "Languages",
    "certifications": "Certifications"
  },
  "ja": {
    "tabDepth": "カードの深さ",
    "tab3": "3秒",
    "tab30": "30秒",
    "tabDeep": "詳細プロフィール",
    "noFields": "公開されている連絡先はありません。",
    "noDeep": "詳細プロフィールはまだ公開されていません。",
    "hidden": "非公開項目 {n}件 — つながった後に共有を依頼できます",
    "saveVcard": "連絡先に保存（vCard）",
    "offer": "Offer · 提供できること",
    "need": "Need · いま必要なこと",
    "projects": "プロジェクト",
    "achievements": "実績",
    "services": "サービス",
    "assets": "保有リソース",
    "network": "ネットワーク",
    "interests": "関心分野",
    "languages": "言語",
    "certifications": "認証"
  }
} as const;
export type CardMessages = (typeof CARD_MESSAGES)["ko"];
