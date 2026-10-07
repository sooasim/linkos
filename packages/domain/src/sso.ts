// F-008 B2B SSO — pure helpers for SAML 2.0 SP configuration and SSO enforcement (no I/O, no XML-DSig here:
// signature validation is done by a maintained library in services/api; these helpers only read configuration
// and the already-verified assertion values).
import type { OrgRole } from "./org";

export const SAML_NAMEID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
] as const;
export type SamlNameIdFormat = (typeof SAML_NAMEID_FORMATS)[number];

export const SAML_BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
export const SAML_BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

/** Well-known attribute names IdPs use for e-mail / display name (Okta, Entra ID, Google Workspace, ADFS, Keycloak). */
export const SAML_EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "emailAddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
] as const;
export const SAML_NAME_ATTRIBUTES = [
  "displayName",
  "name",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "urn:oid:2.16.840.1.113730.3.1.241",
] as const;

// ---------- certificates ----------
const PEM_RE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function b64Body(s: string): string | null {
  const body = s.replace(/\s+/g, "");
  if (body.length < 64 || body.length > 16_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  return body;
}

export function pemFromBase64(body: string): string {
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Accepts one or more PEM certificates, or a bare base64 DER body (as found in <ds:X509Certificate>), and returns
 * normalized PEM strings (64-char lines). Invalid blocks are dropped; callers still parse them with X509Certificate.
 */
export function splitPemCerts(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const blocks = [...text.matchAll(PEM_RE)];
  if (blocks.length) {
    for (const m of blocks) {
      const b = b64Body(m[1]!);
      if (b) out.push(pemFromBase64(b));
    }
  } else {
    const b = b64Body(text);
    if (b) out.push(pemFromBase64(b));
  }
  return [...new Set(out)];
}

// ---------- IdP metadata ----------
export interface IdpMetadata {
  entityId: string | null;
  ssoUrl: string | null;
  certs: string[];
  nameIdFormats: string[];
}

const decodeXmlEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? decodeXmlEntities(m[2] ?? m[3] ?? "") : null;
}

/**
 * Reads entityID, the HTTP-Redirect SingleSignOnService location, signing certificates and NameID formats from an
 * IdP EntityDescriptor (namespace-prefix agnostic). This is admin-supplied configuration that the admin reviews in the
 * form before saving — not a trust decision; response signatures are always verified against the saved certs.
 */
export function parseIdpMetadata(xml: string): IdpMetadata {
  const src = xml.replace(/<!--[\s\S]*?-->/g, "");
  const ed = src.match(/<(?:[\w.-]+:)?EntityDescriptor\b[^>]*>/);
  const entityId = ed ? attr(ed[0], "entityID") : null;
  const idp = src.match(/<(?:[\w.-]+:)?IDPSSODescriptor\b[\s\S]*?<\/(?:[\w.-]+:)?IDPSSODescriptor>/);
  const scope = idp ? idp[0] : src;
  let ssoUrl: string | null = null;
  for (const m of scope.matchAll(/<(?:[\w.-]+:)?SingleSignOnService\b[^>]*>/g)) {
    if (attr(m[0], "Binding") === SAML_BINDING_REDIRECT) {
      ssoUrl = attr(m[0], "Location");
      break;
    }
  }
  const certs: string[] = [];
  for (const kd of scope.matchAll(/<(?:[\w.-]+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?KeyDescriptor>/g)) {
    const use = attr(`<x ${kd[1]}>`, "use");
    if (use && use !== "signing") continue;
    for (const c of kd[2]!.matchAll(/<(?:[\w.-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?X509Certificate>/g)) {
      certs.push(...splitPemCerts(c[1]!));
    }
  }
  const nameIdFormats = [...scope.matchAll(/<(?:[\w.-]+:)?NameIDFormat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?NameIDFormat>/g)].map((m) => m[1]!.trim());
  return { entityId, ssoUrl, certs: [...new Set(certs)], nameIdFormats };
}

/** Attributes of the root <samlp:Response> start tag (Destination, InResponseTo, ID…). Null when the root is not a Response. */
export function samlResponseRootAttributes(xml: string): Record<string, string> | null {
  const src = xml.replace(/^﻿/, "").replace(/<\?xml[\s\S]*?\?>/, "").replace(/^(\s*<!--[\s\S]*?-->)*/, "").trimStart();
  const m = src.match(/^<(?:[\w.-]+:)?Response((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const a of m[1]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[a[1]!] = decodeXmlEntities(a[2] ?? a[3] ?? "");
  return out;
}

// ---------- verified assertion → identity ----------
export interface SamlAttributeMapping {
  emailAttribute?: string | null;
  nameAttribute?: string | null;
}

export interface SamlVerifiedSubject {
  nameID?: string | null;
  nameIDFormat?: string | null;
  attributes?: Record<string, unknown> | null;
}

const firstString = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.trim()) return x.trim();
  return null;
};

/**
 * Picks the e-mail / display name / stable subject from a signature-verified assertion using the org's attribute
 * mapping. Only values present in the assertion are used (nothing is inferred). A configured attribute name is
 * authoritative; otherwise well-known names, then an emailAddress-format NameID. Transient NameIDs change on every
 * login, so the e-mail becomes the identity subject in that case.
 */
export function extractSamlIdentity(subject: SamlVerifiedSubject, mapping: SamlAttributeMapping = {}): { email: string | null; name: string | null; subject: string | null } {
  const attrs = subject.attributes ?? {};
  const fmt = subject.nameIDFormat ?? "";
  let email: string | null = null;
  if (mapping.emailAttribute) email = firstString(attrs[mapping.emailAttribute]);
  else {
    for (const k of SAML_EMAIL_ATTRIBUTES) if ((email = firstString(attrs[k]))) break;
    if (!email && fmt.endsWith(":emailAddress")) email = firstString(subject.nameID);
  }
  let name: string | null = null;
  if (mapping.nameAttribute) name = firstString(attrs[mapping.nameAttribute]);
  else for (const k of SAML_NAME_ATTRIBUTES) if ((name = firstString(attrs[k]))) break;
  if (!name) {
    const given = firstString(attrs["givenName"] ?? attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"]);
    const sur = firstString(attrs["sn"] ?? attrs["surname"] ?? attrs["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"]);
    name = [sur, given].filter(Boolean).join(" ") || null;
  }
  const nameId = firstString(subject.nameID);
  const stable = nameId && !fmt.endsWith(":transient") ? nameId : email;
  return { email: email ? email.toLowerCase() : null, name: name ? name.slice(0, 120) : null, subject: stable };
}

// ---------- SSO enforcement ----------
export type LoginMethod = "email_otp" | "google" | "passkey" | "oidc_sso" | "saml_sso";
export const SSO_LOGIN_METHODS: readonly LoginMethod[] = ["oidc_sso", "saml_sso"];

export interface SsoEnforcementInput {
  /** org policy sso_required */
  ssoRequired: boolean;
  /** the org has at least one enabled SSO connection (OIDC or SAML); enforcement never applies without one */
  ssoAvailable: boolean;
  email: string | null;
  verifiedDomains: string[];
  /** the person's active role in that org (null when not an active member) */
  role: OrgRole | null;
  method: LoginMethod;
}

/**
 * Org policy `sso_required`: e-mails on the org's verified domains must sign in through the company IdP.
 * Break-glass: active owners keep e-mail OTP so an IdP outage or misconfiguration cannot lock the org out.
 */
export function ssoEnforcementDecision(i: SsoEnforcementInput): "allow" | "sso_required" {
  if (!i.ssoRequired || !i.ssoAvailable) return "allow";
  if (SSO_LOGIN_METHODS.includes(i.method)) return "allow";
  const at = i.email ? i.email.lastIndexOf("@") : -1;
  const domain = at > 0 ? i.email!.slice(at + 1).toLowerCase() : null;
  if (!domain || !i.verifiedDomains.includes(domain)) return "allow";
  if (i.role === "owner" && i.method === "email_otp") return "allow";
  return "sso_required";
}

/** Session revocation scope when enforcement is switched on: non-SSO sessions (incl. legacy sessions with no method). */
export function isSsoSessionMethod(method: string | null | undefined): boolean {
  return method === "oidc_sso" || method === "saml_sso";
}
