// F-034 공개범위: Public/Business/Trusted/Partner 필드 ACL. F-035 Access Request.
export const VISIBILITY_LEVELS = ["public", "business", "trusted", "partner", "private"] as const;
export type Visibility = (typeof VISIBILITY_LEVELS)[number];

const RANK: Record<Visibility, number> = { public: 0, business: 1, trusted: 2, partner: 3, private: 99 };

/** Audience = the highest level the viewer has been granted. Owner sees everything. */
export type Audience = Exclude<Visibility, "private"> | "owner";

export function canSee(field: Visibility, audience: Audience): boolean {
  if (audience === "owner") return true;
  if (field === "private") return false;
  return RANK[field] <= RANK[audience];
}

export function filterFieldsByAudience<T extends { visibility: Visibility }>(fields: T[], audience: Audience): T[] {
  return fields.filter((f) => canSee(f.visibility, audience));
}

/** Guests landing on an exchange link see public + business (the sender chose to exchange). */
export const EXCHANGE_AUDIENCE: Audience = "business";

export function hiddenFieldCount<T extends { visibility: Visibility }>(fields: T[], audience: Audience): number {
  return fields.length - filterFieldsByAudience(fields, audience).length;
}

/**
 * F-092 / 백서 §7 privacy_penalty input: share (0..1) of a profile's fields this audience cannot see under the field
 * ACL. Private fields count as hidden (they are withheld from every viewer but the owner). No fields → 0.
 */
export function restrictedFieldRatio<T extends { visibility: Visibility }>(fields: T[], audience: Audience): number {
  if (!fields.length) return 0;
  return (fields.length - filterFieldsByAudience(fields, audience).length) / fields.length;
}

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && (VISIBILITY_LEVELS as readonly string[]).includes(v);
}
