// Software WebAuthn authenticator (ES256, "none" attestation) for F-006 tests.
// Produces the exact JSON shapes @simplewebauthn/browser hands to the server, signed with a real P-256 key.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export function createSoftAuthenticator(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = randomBytes(16);
  let counter = 0;
  let userHandle: Uint8Array | null = null;

  const cose = new Map<number, number | Uint8Array>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]);

  function authData(rpId: string, flags: number, attested: boolean): Buffer {
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(counter);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags]), cnt];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      parts.push(Buffer.alloc(16), len, credId, Buffer.from(isoCBOR.encode(cose)));
    }
    return Buffer.concat(parts);
  }

  return {
    credentialId: b64u(credId),
    register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, opts: { origin?: string } = {}) {
      userHandle = Buffer.from(options.user.id, "base64url");
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: opts.origin ?? origin, crossOrigin: false }));
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(options.rp.id!, 0x45, true)]]) as never);
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    login(options: { challenge: string; rpId?: string }, opts: { origin?: string; rpId?: string; resetCounter?: boolean } = {}) {
      counter = opts.resetCounter ? 0 : counter + 1;
      const ad = authData(opts.rpId ?? options.rpId!, 0x05, false);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: opts.origin ?? origin, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([ad, sha(clientDataJSON)]), privateKey);
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(signature), userHandle: userHandle ? b64u(userHandle) : undefined },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
