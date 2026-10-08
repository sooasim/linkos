// X-004 detached PKCS#7 / CMS SignedData (DER) — the `signature` file of an Apple Wallet .pkpass.
// ASN.1 structures from @peculiar/asn1-cms + asn1-x509 (pinned exactly); keys and hashing stay in node:crypto.
import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import {
  Attribute,
  CertificateChoices,
  CertificateSet,
  ContentInfo,
  DigestAlgorithmIdentifiers,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedData,
  SignerIdentifier,
  SignerInfo,
  SignerInfos,
  id_data,
  id_signedData,
} from "@peculiar/asn1-cms";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import { AlgorithmIdentifier, Certificate, Time } from "@peculiar/asn1-x509";

const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
};

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** DER OBJECT IDENTIFIER. */
export function encodeOid(oid: string): Uint8Array {
  const parts = oid.split(".").map(Number);
  const body: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    body.push(...stack);
  }
  return Uint8Array.from([0x06, ...derLength(body.length), ...body]);
}

const ab = (u: Uint8Array | Buffer): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function pemToDer(pem: string, label: string): Buffer {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (!m) throw new Error(`PEM ${label} not found`);
  return Buffer.from(m[1]!.replace(/\s+/g, ""), "base64");
}

/** Accept a PEM string or base64 of a PEM (env vars often hold the latter). */
export function normalizePem(v: string): string {
  const t = v.trim();
  if (t.includes("-----BEGIN")) return t.replace(/\\n/g, "\n");
  return Buffer.from(t, "base64").toString("utf8");
}

/** Read one TLV starting at `off`; returns [headerLen, totalLen]. */
function tlv(buf: Uint8Array, off: number): [number, number] {
  const l0 = buf[off + 1]!;
  if (l0 < 0x80) return [2, 2 + l0];
  const n = l0 & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 2 + i]!;
  return [2 + n, 2 + n + len];
}

/** The [0] IMPLICIT signedAttrs inside an encoded SignerInfo, re-tagged as SET (0x31) — the bytes that get signed. */
function signedAttrsForSigning(signerInfoDer: Uint8Array): Uint8Array {
  const [h] = tlv(signerInfoDer, 0);
  let off = h;
  while (off < signerInfoDer.length) {
    const [, total] = tlv(signerInfoDer, off);
    if (signerInfoDer[off] === 0xa0) {
      const out = signerInfoDer.slice(off, off + total);
      out[0] = 0x31;
      return out;
    }
    off += total;
  }
  throw new Error("signedAttrs not found");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export interface SignerMaterial {
  certPem: string;
  keyPem: string;
  keyPassphrase?: string;
  /** intermediate(s) to embed, e.g. Apple WWDR */
  chainPem?: string[];
}

/** Detached CMS SignedData over `content` with signed attributes (contentType, signingTime, messageDigest). */
export function signDetached(content: Uint8Array, m: SignerMaterial, signingTime = new Date()): Buffer {
  const signerCert = AsnConvert.parse(pemToDer(m.certPem, "CERTIFICATE"), Certificate);
  const chain = (m.chainPem ?? []).map((p) => AsnConvert.parse(pemToDer(p, "CERTIFICATE"), Certificate));
  const key = createPrivateKey({ key: m.keyPem, passphrase: m.keyPassphrase });
  const isEc = key.asymmetricKeyType === "ec";

  const digest = createHash("sha256").update(content).digest();
  const attrs = [
    new Attribute({ attrType: OID.contentType, attrValues: [ab(encodeOid(id_data))] }),
    new Attribute({ attrType: OID.signingTime, attrValues: [AsnConvert.serialize(new Time(signingTime))] }),
    new Attribute({ attrType: OID.messageDigest, attrValues: [AsnConvert.serialize(new OctetString(ab(digest)))] }),
  ];
  // DER: SET OF elements sorted by their encodings (OpenSSL re-encodes canonically when verifying)
  attrs.sort((a, b) => compareBytes(new Uint8Array(AsnConvert.serialize(a)), new Uint8Array(AsnConvert.serialize(b))));

  const signerInfo = new SignerInfo({
    version: 1,
    sid: new SignerIdentifier({ issuerAndSerialNumber: new IssuerAndSerialNumber({ issuer: signerCert.tbsCertificate.issuer, serialNumber: signerCert.tbsCertificate.serialNumber }) }),
    digestAlgorithm: new AlgorithmIdentifier({ algorithm: OID.sha256 }),
    signedAttrs: attrs,
    signatureAlgorithm: isEc ? new AlgorithmIdentifier({ algorithm: OID.ecdsaWithSha256 }) : new AlgorithmIdentifier({ algorithm: OID.rsaEncryption, parameters: ab(Uint8Array.from([5, 0])) }),
    signature: new OctetString(new ArrayBuffer(0)),
  });
  const toSign = signedAttrsForSigning(new Uint8Array(AsnConvert.serialize(signerInfo)));
  signerInfo.signature = new OctetString(ab(cryptoSign("sha256", toSign, key)));

  const signedData = new SignedData({
    version: 1,
    digestAlgorithms: new DigestAlgorithmIdentifiers([new AlgorithmIdentifier({ algorithm: OID.sha256 })]),
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: id_data }),
    certificates: new CertificateSet([signerCert, ...chain].map((certificate) => new CertificateChoices({ certificate }))),
    signerInfos: new SignerInfos([signerInfo]),
  });
  const ci = new ContentInfo({ contentType: id_signedData, content: AsnConvert.serialize(signedData) });
  return Buffer.from(AsnConvert.serialize(ci));
}
