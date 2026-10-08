// F-127 필드 매핑 — 조직/사용자별 외부 시스템(CRM) 필드 매핑. 순수 검증·적용 로직.
import { splitName } from "./template";

export const CRM_PROVIDERS = ["microsoft", "salesforce", "hubspot", "dynamics"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];
export const CRM_OBJECTS = ["contact", "lead"] as const;
export type CrmObject = (typeof CRM_OBJECTS)[number];

export const LOCAL_FIELDS = ["firstName", "lastName", "fullName", "company", "jobTitle", "department", "email", "phone", "address", "website", "linkosId"] as const;
export type LocalField = (typeof LOCAL_FIELDS)[number];

export interface FieldMapEntry {
  local: LocalField;
  remote: string;
}

const m = (pairs: [LocalField, string][]): FieldMapEntry[] => pairs.map(([local, remote]) => ({ local, remote }));

export const DEFAULT_MAPPINGS: Record<CrmProvider, Partial<Record<CrmObject, FieldMapEntry[]>>> = {
  microsoft: {
    contact: m([["firstName", "givenName"], ["lastName", "surname"], ["fullName", "displayName"], ["company", "companyName"], ["jobTitle", "jobTitle"], ["department", "department"], ["email", "emailAddresses"], ["phone", "businessPhones"], ["website", "businessHomePage"]]),
  },
  salesforce: {
    contact: m([["firstName", "FirstName"], ["lastName", "LastName"], ["jobTitle", "Title"], ["department", "Department"], ["email", "Email"], ["phone", "Phone"]]),
    lead: m([["firstName", "FirstName"], ["lastName", "LastName"], ["company", "Company"], ["jobTitle", "Title"], ["email", "Email"], ["phone", "Phone"], ["website", "Website"]]),
  },
  hubspot: {
    contact: m([["firstName", "firstname"], ["lastName", "lastname"], ["company", "company"], ["jobTitle", "jobtitle"], ["email", "email"], ["phone", "phone"], ["website", "website"]]),
  },
  dynamics: {
    contact: m([["firstName", "firstname"], ["lastName", "lastname"], ["jobTitle", "jobtitle"], ["department", "department"], ["email", "emailaddress1"], ["phone", "telephone1"], ["website", "websiteurl"], ["address", "address1_composite"]]),
    lead: m([["firstName", "firstname"], ["lastName", "lastname"], ["company", "companyname"], ["jobTitle", "jobtitle"], ["email", "emailaddress1"], ["phone", "telephone1"], ["website", "websiteurl"]]),
  },
};

/** Remote fields the provider rejects a create without. */
export const REQUIRED_REMOTE: Record<CrmProvider, Partial<Record<CrmObject, string[]>>> = {
  microsoft: { contact: [] },
  salesforce: { contact: ["LastName"], lead: ["LastName", "Company"] },
  hubspot: { contact: [] },
  dynamics: { contact: ["lastname"], lead: ["lastname"] },
};

export function supportsObject(provider: CrmProvider, object: CrmObject): boolean {
  return Boolean(DEFAULT_MAPPINGS[provider][object]);
}

const REMOTE_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

export function validateMapping(provider: CrmProvider, object: CrmObject, entries: FieldMapEntry[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!supportsObject(provider, object)) errors.push(`unsupported_object:${object}`);
  const seen = new Set<string>();
  for (const e of entries) {
    if (!(LOCAL_FIELDS as readonly string[]).includes(e.local)) errors.push(`unknown_local:${e.local}`);
    if (!REMOTE_RE.test(e.remote)) errors.push(`invalid_remote:${e.remote}`);
    if (seen.has(e.remote.toLowerCase())) errors.push(`duplicate_remote:${e.remote}`);
    seen.add(e.remote.toLowerCase());
  }
  for (const req of REQUIRED_REMOTE[provider][object] ?? []) if (!entries.some((e) => e.remote === req)) errors.push(`missing_required:${req}`);
  return { ok: errors.length === 0, errors };
}

export interface LocalContact {
  id: string;
  fullName: string;
  company?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
}

export function localValues(c: LocalContact): Record<LocalField, string | null> {
  const { first, last } = splitName(c.fullName);
  return {
    firstName: first || null,
    lastName: last || c.fullName || null,
    fullName: c.fullName || null,
    company: c.company ?? null,
    jobTitle: c.jobTitle ?? null,
    department: c.department ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    address: c.address ?? null,
    website: c.website ?? null,
    linkosId: c.id,
  };
}

/**
 * Apply a mapping. Empty local values are omitted (never blank out a CRM field the user filled there).
 * Missing required remote values are reported so the job fails loudly instead of inventing data.
 */
export function applyMapping(provider: CrmProvider, object: CrmObject, entries: FieldMapEntry[], c: LocalContact): { values: Record<string, string>; missingRequired: string[] } {
  const v = localValues(c);
  const values: Record<string, string> = {};
  for (const e of entries) {
    const val = v[e.local];
    if (val != null && String(val).trim() !== "") values[e.remote] = String(val).slice(0, 255);
  }
  const missingRequired = (REQUIRED_REMOTE[provider][object] ?? []).filter((r) => !values[r]);
  return { values, missingRequired };
}
