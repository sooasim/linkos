// Test-only SAML 2.0 IdP for F-008: a self-signed X.509 signing certificate built with node:crypto (minimal DER
// encoder — node has no certificate generator) and Responses/Assertions signed with xml-crypto (the same XML-DSig
// library the SP verifies with, used here in the IdP role).
import { type KeyObject, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

// ---------- minimal DER ----------
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const v of rest) {
    const chunk: number[] = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) {
      chunk.unshift((x & 0x7f) | 0x80);
      x >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/, "$1$2$3$4$5$6Z")));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));

export interface IdpKey {
  privateKey: KeyObject;
  privateKeyPem: string;
  certPem: string;
  fingerprint: string;
}

/** Self-signed RSA-2048 / SHA-256 certificate. */
export function makeIdpKey(cn: string, days = 365): IdpKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algo = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(randomBytes(12)),
    algo,
    name(cn),
    seq(utcTime(new Date(now - 864e5)), utcTime(new Date(now + days * 864e5))),
    name(cn),
    publicKey.export({ type: "spki", format: "der" }) as Buffer,
  );
  const sig = sign("sha256", tbs, privateKey);
  const der = seq(tbs, algo, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der.toString("base64");
  return {
    privateKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certPem: `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprint: createHash("sha256").update(der).digest("hex"),
  };
}

export function idpMetadataXml(entityId: string, ssoUrl: string, certs: IdpKey[]): string {
  const kd = certs
    .map((c) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${c.certPem.replace(/-----[^-]+-----|\s/g, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`)
    .join("");
  return `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${kd}<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}

/** What the IdP sees from an SP-initiated HTTP-Redirect AuthnRequest. */
export function readAuthnRequest(url: string): { id: string; acs: string | null; issuer: string | null; destination: string | null; relayState: string; xml: string } {
  const u = new URL(url);
  const xml = inflateRawSync(Buffer.from(u.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  const attr = (n: string) => xml.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1] ?? null;
  return {
    id: attr("ID")!,
    acs: attr("AssertionConsumerServiceURL"),
    destination: attr("Destination"),
    issuer: xml.match(/<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/)?.[1] ?? null,
    relayState: u.searchParams.get("RelayState")!,
    xml,
  };
}

export interface ResponseOpts {
  issuer: string;
  inResponseTo: string;
  destination?: string | null;
  recipient: string;
  audience: string;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string>;
  notBefore?: Date;
  notOnOrAfter?: Date;
  /** what to sign (default: the assertion) */
  sign?: "assertion" | "response" | "none";
  key?: IdpKey;
  assertionId?: string;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Builds a SAML Response (XML string, not base64). */
export function buildResponse(o: ResponseOpts): string {
  const now = new Date();
  const nb = o.notBefore ?? new Date(now.getTime() - 60_000);
  const na = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const aid = o.assertionId ?? `_a${randomBytes(10).toString("hex")}`;
  const attrs = Object.entries(o.attributes ?? {})
    .map(([k, v]) => `<saml:Attribute Name="${esc(k)}"><saml:AttributeValue>${esc(v)}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${esc(o.issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"}">${esc(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${iso(na)}" Recipient="${esc(o.recipient)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(nb)}" NotOnOrAfter="${iso(na)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "") +
    `</saml:Assertion>`;
  const dest = o.destination === null ? "" : ` Destination="${esc(o.destination ?? o.recipient)}"`;
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(10).toString("hex")}" Version="2.0" IssueInstant="${iso(now)}"${dest} InResponseTo="${o.inResponseTo}">` +
    `<saml:Issuer>${esc(o.issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  const mode = o.sign ?? "assertion";
  if (mode !== "none") xml = signXml(xml, o.key!, mode);
  return xml;
}

export function signXml(xml: string, key: IdpKey, what: "assertion" | "response"): string {
  const target = what === "assertion" ? "/*[local-name(.)='Response']/*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']";
  const sig = new SignedXml({
    privateKey: key.privateKeyPem,
    publicCert: key.certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: target,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, { location: { reference: `${target}/*[local-name(.)='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}

export const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
