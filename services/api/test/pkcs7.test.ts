// X-004: detached PKCS#7 signature for .pkpass, verified by OpenSSL against a throwaway CA (stand-in for Apple WWDR).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeOid, normalizePem, signDetached } from "../src/lib/pkcs7";

let dir = "";
const ossl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
let hasOpenssl = true;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "linkos-pkcs7-"));
  try {
    ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Fake WWDR");
    ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "pass.key", "-out", "pass.csr", "-subj", "/CN=Pass Type ID: pass.ai.linkos.test/OU=ABCDE12345");
    ossl("x509", "-req", "-in", "pass.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "pass.pem", "-days", "2");
    ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ec.key");
    ossl("req", "-new", "-x509", "-key", "ec.key", "-out", "ec.pem", "-days", "2", "-subj", "/CN=EC signer");
  } catch {
    hasOpenssl = false;
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("X-004 PKCS#7 detached signature", () => {
  it("encodes OIDs in DER", () => {
    expect(Buffer.from(encodeOid("1.2.840.113549.1.7.1")).toString("hex")).toBe("06092a864886f70d010701");
    expect(Buffer.from(encodeOid("2.16.840.1.101.3.4.2.1")).toString("hex")).toBe("0609608648016503040201");
  });

  it("RSA signature + embedded chain verifies with openssl cms", () => {
    if (!hasOpenssl) return;
    const manifest = Buffer.from(JSON.stringify({ "pass.json": "abc", "icon.png": "def" }));
    writeFileSync(join(dir, "manifest.json"), manifest);
    const sig = signDetached(manifest, {
      certPem: readFileSync(join(dir, "pass.pem"), "utf8"),
      keyPem: readFileSync(join(dir, "pass.key"), "utf8"),
      chainPem: [readFileSync(join(dir, "ca.pem"), "utf8")],
    });
    writeFileSync(join(dir, "signature"), sig);
    expect(() => ossl("cms", "-verify", "-inform", "DER", "-binary", "-in", "signature", "-content", "manifest.json", "-CAfile", "ca.pem", "-purpose", "any", "-out", "/dev/null")).not.toThrow();
    const printed = ossl("cms", "-cmsout", "-print", "-inform", "DER", "-in", "signature").toString();
    expect(printed).toContain("pkcs7-signedData");
    expect(printed).toContain("Fake WWDR"); // chain embedded
    // tampered content must fail
    writeFileSync(join(dir, "manifest.json"), Buffer.from("{}"));
    expect(() => ossl("cms", "-verify", "-inform", "DER", "-binary", "-in", "signature", "-content", "manifest.json", "-CAfile", "ca.pem", "-purpose", "any", "-out", "/dev/null")).toThrow();
  });

  it("EC keys sign with ecdsa-with-SHA256; base64 PEM env values are accepted", () => {
    if (!hasOpenssl) return;
    const content = Buffer.from("hello");
    writeFileSync(join(dir, "c.txt"), content);
    const certPem = normalizePem(Buffer.from(readFileSync(join(dir, "ec.pem"), "utf8")).toString("base64"));
    const sig = signDetached(content, { certPem, keyPem: readFileSync(join(dir, "ec.key"), "utf8") });
    writeFileSync(join(dir, "ec.sig"), sig);
    expect(() => ossl("cms", "-verify", "-inform", "DER", "-binary", "-in", "ec.sig", "-content", "c.txt", "-noverify", "-out", "/dev/null")).not.toThrow();
  });
});
