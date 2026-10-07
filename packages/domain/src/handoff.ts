// 백서 16. Handoff Engine 의사결정 규칙 (F-037, F-038, F-039, F-041~F-048)
// 채널 순서는 런타임 capability vector로 결정한다. QR은 항상 마지막(F-048).

export type Channel =
  | "ble_proximity" // 앱↔앱, foreground BLE + 상호 승인 (네이티브 앱 전용)
  | "os_share" // Web Share / native share 로 일회성 HTTPS 링크
  | "nfc_accessory" // NFC 카드/스티커/링 (NDEF URL)
  | "short_code" // lk.to + 6자리
  | "web_rendezvous" // 양쪽 웹 exchange 화면에서 서버 rendezvous
  | "acoustic" // 실험 채널 (F-047, P3)
  | "local_receipt" // 오프라인 앱↔앱 서명 영수증 (F-052)
  | "qr"; // 최종 범용 폴백

export interface CapabilityVector {
  installedApp: boolean; // sender가 네이티브 앱에서 실행 중
  nativeBle: boolean;
  receiverHasApp: boolean | null; // 모르면 null (수신 기기 OS를 미리 안다고 가정하지 않음)
  webShare: boolean;
  appClipEntry: boolean;
  nfcAccessoryEnabled: boolean;
  camera: boolean;
  online: boolean;
  pwaInstalled: boolean;
  receiverMode: "unknown" | "nearby_app" | "web_exchange_screen";
  experimentalAcoustic?: boolean;
}

export const DEFAULT_CAPABILITIES: CapabilityVector = {
  installedApp: false,
  nativeBle: false,
  receiverHasApp: null,
  webShare: false,
  appClipEntry: false,
  nfcAccessoryEnabled: false,
  camera: false,
  online: true,
  pwaInstalled: false,
  receiverMode: "unknown",
};

/** Ordered channel ladder. QR is always present and always last. */
export function planChannels(cap: CapabilityVector): Channel[] {
  const ladder: Channel[] = [];
  const add = (c: Channel) => {
    if (!ladder.includes(c)) ladder.push(c);
  };

  if (!cap.online) {
    // 네트워크 불안정 + 양쪽 앱 → local signed receipt, 실패 시 QR/로컬 코드
    if (cap.installedApp && cap.nativeBle) add("local_receipt");
    add("qr");
    return ladder;
  }

  // 양쪽 앱 + foreground → BLE proximity (상호 승인 필수)
  if (cap.installedApp && cap.nativeBle && (cap.receiverHasApp === true || cap.receiverMode === "nearby_app")) {
    add("ble_proximity");
  }
  // 둘 다 웹 exchange 화면 → 서버 rendezvous + 단축코드 (브라우저 P2P 금지)
  if (cap.receiverMode === "web_exchange_screen") {
    add("web_rendezvous");
    add("short_code");
  }
  // 비회원 수신자에게 가장 현실적인 경로
  if (cap.webShare || cap.installedApp) add("os_share");
  if (cap.nfcAccessoryEnabled) add("nfc_accessory");
  add("short_code");
  if (cap.experimentalAcoustic) add("acoustic");
  add("qr");
  return ladder;
}

export type AttemptOutcome = "success" | "failed" | "cancelled" | "timeout" | "unsupported";

/** Timeout before automatically advancing to the next channel (ms). */
export const CHANNEL_TIMEOUT_MS: Record<Channel, number> = {
  ble_proximity: 12_000,
  os_share: 20_000,
  nfc_accessory: 20_000,
  short_code: 45_000,
  web_rendezvous: 30_000,
  acoustic: 10_000,
  local_receipt: 15_000,
  qr: Number.POSITIVE_INFINITY,
};

/**
 * Next channel after an attempt. Returns null when the exchange is done
 * (success) — QR never fails over (it is the final fallback).
 */
export function nextChannel(ladder: Channel[], current: Channel, outcome: AttemptOutcome): Channel | null {
  if (outcome === "success") return null;
  const idx = ladder.indexOf(current);
  if (idx < 0) return ladder[ladder.length - 1] ?? "qr";
  return ladder[idx + 1] ?? "qr";
}

export const CHANNEL_LABEL_KO: Record<Channel, string> = {
  ble_proximity: "근처 앱 사용자와 교환",
  os_share: "공유 시트로 보내기",
  nfc_accessory: "NFC 카드 태그",
  short_code: "단축코드",
  web_rendezvous: "웹 화면 페어링",
  acoustic: "음향 페어링(실험)",
  local_receipt: "오프라인 교환 영수증",
  qr: "QR 코드",
};
