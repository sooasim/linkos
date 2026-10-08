// 백서 19. INTRO_PROPOSED → PARTY_A_ACCEPTED → PARTY_B_ACCEPTED → ROOM_CREATED → MEETING_BOOKED → ACTIVE → WON/ARCHIVED
export const INTRO_STATES = [
  "INTRO_PROPOSED", "PARTY_A_ACCEPTED", "PARTY_B_ACCEPTED", "ROOM_CREATED", "MEETING_BOOKED", "ACTIVE", "WON", "ARCHIVED", "DECLINED",
] as const;
export type IntroState = (typeof INTRO_STATES)[number];

const NEXT: Record<IntroState, IntroState[]> = {
  INTRO_PROPOSED: ["PARTY_A_ACCEPTED", "DECLINED", "ARCHIVED"],
  PARTY_A_ACCEPTED: ["PARTY_B_ACCEPTED", "DECLINED", "ARCHIVED"],
  PARTY_B_ACCEPTED: ["ROOM_CREATED"],
  ROOM_CREATED: ["MEETING_BOOKED", "ACTIVE", "ARCHIVED"],
  MEETING_BOOKED: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["WON", "ARCHIVED"],
  WON: ["ARCHIVED"],
  ARCHIVED: [],
  DECLINED: [],
};

export function canIntroTransition(from: IntroState, to: IntroState): boolean {
  return NEXT[from].includes(to);
}

/** Contact details are never revealed to either party before both accept. */
export function contactsRevealed(s: IntroState): boolean {
  return ["PARTY_B_ACCEPTED", "ROOM_CREATED", "MEETING_BOOKED", "ACTIVE", "WON"].includes(s);
}
