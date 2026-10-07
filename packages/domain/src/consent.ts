// F-009 동의 분리 (서비스/개인정보/마케팅), 백서 12: exchange/integration/recording 동의는 별도 기록 + policy_version.
export const CONSENT_TYPES = ["terms", "privacy", "marketing", "age_14", "exchange", "integration_google", "recording"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const POLICY_VERSIONS: Record<ConsentType, string> = {
  terms: "2026-10-01",
  privacy: "2026-10-01",
  marketing: "2026-10-01",
  age_14: "2026-10-01",
  exchange: "2026-10-01",
  integration_google: "2026-10-01",
  recording: "2026-10-01",
};

export const REQUIRED_FOR_SIGNUP: ConsentType[] = ["terms", "privacy", "age_14"];

export interface ConsentDecision {
  type: ConsentType;
  granted: boolean;
}

export function missingRequiredConsents(decisions: ConsentDecision[]): ConsentType[] {
  return REQUIRED_FOR_SIGNUP.filter((t) => !decisions.some((d) => d.type === t && d.granted));
}

export interface RecordingConsentState {
  /** consent record exists for the meeting owner */
  ownerConsented: boolean;
  /** every participant acknowledged (or org policy = one-party notice with visible indicator) */
  participantsAcknowledged: boolean;
  policy: "all_party" | "one_party_notice";
}

/** F-084 녹음 동의 게이트: 동의 UX와 기록 없이 녹음 시작 불가. */
export function canStartRecording(s: RecordingConsentState): { ok: boolean; reason?: string } {
  if (!s.ownerConsented) return { ok: false, reason: "owner_consent_missing" };
  if (s.policy === "all_party" && !s.participantsAcknowledged) return { ok: false, reason: "participant_consent_missing" };
  return { ok: true };
}
