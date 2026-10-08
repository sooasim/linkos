// F-008 B2B SSO — pure SAML configuration helpers and SSO enforcement decision.
import { describe, expect, it } from "vitest";
import { extractSamlIdentity, isSsoSessionMethod, parseIdpMetadata, samlResponseRootAttributes, splitPemCerts, ssoEnforcementDecision } from "../src/index";

const B64 = "MIIB" + "A".repeat(120) + "==";
const B64_2 = "MIIC" + "B".repeat(120) + "==";

describe("F-008 splitPemCerts", () => {
  it("normalizes PEM blocks and bare base64 bodies, drops garbage, dedupes", () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${B64.slice(0, 50)}\n${B64.slice(50)}\n-----END CERTIFICATE-----`;
    const out = splitPemCerts(`${pem}\n${pem}\n-----BEGIN CERTIFICATE-----\nnot base64!!\n-----END CERTIFICATE-----`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=]{64}\n/);
    expect(splitPemCerts(`  ${B64}  `)).toHaveLength(1);
    expect(splitPemCerts("hello")).toEqual([]);
    expect(splitPemCerts(null)).toEqual([]);
  });
});

describe("F-008 parseIdpMetadata", () => {
  const xml = `<?xml version="1.0"?>
  <!-- <md:EntityDescriptor entityID="https://evil"> -->
  <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.acme.com/saml?a=1&amp;b=2">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${B64_2}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
        ${B64}
      </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${B64_2.replace("MIIC", "MIID")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.com/post"/>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.com/redirect"/>
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>`;

  it("reads entityID, the HTTP-Redirect SSO URL, signing certs (not encryption-only) and NameID formats", () => {
    const m = parseIdpMetadata(xml);
    expect(m.entityId).toBe("https://idp.acme.com/saml?a=1&b=2");
    expect(m.ssoUrl).toBe("https://idp.acme.com/redirect");
    expect(m.certs).toHaveLength(2); // signing + unspecified use; encryption-only skipped
    expect(m.certs[0]).toContain(B64.slice(0, 64));
    expect(m.nameIdFormats).toEqual(["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"]);
  });

  it("works without prefixes and returns nulls for unrelated XML", () => {
    const m = parseIdpMetadata(`<EntityDescriptor entityID='x'><IDPSSODescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://i/sso"/></IDPSSODescriptor></EntityDescriptor>`);
    expect(m).toMatchObject({ entityId: "x", ssoUrl: "https://i/sso", certs: [] });
    expect(parseIdpMetadata("<html></html>")).toEqual({ entityId: null, ssoUrl: null, certs: [], nameIdFormats: [] });
  });
});

describe("F-008 samlResponseRootAttributes", () => {
  it("reads only the root Response start tag", () => {
    const x = `<?xml version="1.0" encoding="UTF-8"?><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Destination="https://sp/acs?x=1&amp;y=2" InResponseTo='_q1'><saml:Assertion Destination="https://evil"/></samlp:Response>`;
    expect(samlResponseRootAttributes(x)).toMatchObject({ ID: "_r1", Destination: "https://sp/acs?x=1&y=2", InResponseTo: "_q1" });
    expect(samlResponseRootAttributes(`<Response>`)).toEqual({});
    expect(samlResponseRootAttributes(`<samlp:LogoutResponse ID="a">`)).toBeNull();
    expect(samlResponseRootAttributes(`<x/><Response Destination="https://evil">`)).toBeNull();
  });
});

describe("F-008 extractSamlIdentity", () => {
  it("uses the configured attribute mapping first", () => {
    const r = extractSamlIdentity({ nameID: "abc-123", nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", attributes: { workMail: "Kim@Acme.com", email: "other@acme.com", fullName: "김 철수" } }, { emailAttribute: "workMail", nameAttribute: "fullName" });
    expect(r).toEqual({ email: "kim@acme.com", name: "김 철수", subject: "abc-123" });
  });
  it("falls back to well-known attributes, then an emailAddress NameID; never invents values", () => {
    expect(extractSamlIdentity({ nameID: "x", nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", attributes: { "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": ["a@acme.com"] } }).email).toBe("a@acme.com");
    expect(extractSamlIdentity({ nameID: "b@acme.com", nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" })).toEqual({ email: "b@acme.com", name: null, subject: "b@acme.com" });
    expect(extractSamlIdentity({ nameID: "opaque", nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" }).email).toBeNull();
    // configured attribute missing → no fallback guess
    expect(extractSamlIdentity({ nameID: "c@acme.com", nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", attributes: { email: "d@acme.com" } }, { emailAttribute: "workMail" }).email).toBeNull();
    expect(extractSamlIdentity({ nameID: "x", attributes: { givenName: "철수", sn: "김", email: "k@acme.com" } }).name).toBe("김 철수");
  });
  it("uses the e-mail as subject for transient NameIDs", () => {
    expect(extractSamlIdentity({ nameID: "_tmp", nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient", attributes: { mail: "t@acme.com" } }).subject).toBe("t@acme.com");
  });
});

describe("F-008 ssoEnforcementDecision", () => {
  const base = { ssoRequired: true, ssoAvailable: true, email: "kim@acme.com", verifiedDomains: ["acme.com"], role: "member" as const };
  it("blocks OTP / Google / passkey for verified-domain e-mails when SSO is required", () => {
    for (const method of ["email_otp", "google", "passkey"] as const) expect(ssoEnforcementDecision({ ...base, method })).toBe("sso_required");
    expect(ssoEnforcementDecision({ ...base, role: null, method: "google" })).toBe("sso_required");
  });
  it("allows SSO methods, other domains, policy off, or no enabled SSO connection", () => {
    expect(ssoEnforcementDecision({ ...base, method: "saml_sso" })).toBe("allow");
    expect(ssoEnforcementDecision({ ...base, method: "oidc_sso" })).toBe("allow");
    expect(ssoEnforcementDecision({ ...base, email: "kim@gmail.com", method: "email_otp" })).toBe("allow");
    expect(ssoEnforcementDecision({ ...base, ssoRequired: false, method: "email_otp" })).toBe("allow");
    expect(ssoEnforcementDecision({ ...base, ssoAvailable: false, method: "email_otp" })).toBe("allow");
  });
  it("break-glass: owners keep e-mail OTP only", () => {
    expect(ssoEnforcementDecision({ ...base, role: "owner", method: "email_otp" })).toBe("allow");
    expect(ssoEnforcementDecision({ ...base, role: "owner", method: "google" })).toBe("sso_required");
    expect(ssoEnforcementDecision({ ...base, role: "admin", method: "email_otp" })).toBe("sso_required");
  });
  it("isSsoSessionMethod", () => {
    expect([isSsoSessionMethod("saml_sso"), isSsoSessionMethod("oidc_sso"), isSsoSessionMethod("email_otp"), isSsoSessionMethod(null)]).toEqual([true, true, false, false]);
  });
});
