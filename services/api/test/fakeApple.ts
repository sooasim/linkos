// Local fake of Sign in with Apple (F-001/F-060): /auth/keys (JWKS with RS256 + ES256 keys), /auth/token (verifies the
// ES256 client-secret JWT and the one-time code) and an `authorize()` helper that plays the user consenting at Apple and
// returns what Apple would form_post to the callback. Tokens are always issued as https://appleid.apple.com.
import { type Server, createServer } from "node:http";
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";

export interface AppleUser {
  sub: string;
  email?: string | null;
  emailVerified?: boolean | string;
  isPrivateEmail?: boolean | string;
  name?: { firstName?: string; lastName?: string };
}

export interface AuthorizeOpts {
  aud?: string;
  iss?: string;
  nonce?: string;
  expiresInSec?: number;
  alg?: "RS256" | "ES256";
  signWithUnknownKey?: boolean;
  /** Apple sends the `user` JSON only on the first authorization */
  firstLogin?: boolean;
}

export interface FakeApple {
  url: string;
  clientId: string;
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM of the developer's .p8 key (APPLE_PRIVATE_KEY) */
  privateKeyPem: string;
  authorize: (authUrl: string, user: AppleUser, opts?: AuthorizeOpts) => Promise<{ code: string; state: string; user?: string }>;
  tokenCalls: { ok: boolean; reason?: string; secretClaims?: Record<string, unknown>; secretHeader?: Record<string, unknown> }[];
  close: () => Promise<void>;
}

export async function startFakeApple(clientId = "com.linkos.web", teamId = "TEAM123456", keyId = "KEY1234567"): Promise<FakeApple> {
  // developer key (client secret)
  const dev = await generateKeyPair("ES256", { extractable: true });
  const privateKeyPem = await exportPKCS8(dev.privateKey);
  // Apple's signing keys
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const ec = await generateKeyPair("ES256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [
      { ...(await exportJWK(rsa.publicKey)), kid: "apple-rsa", alg: "RS256", use: "sig" },
      { ...(await exportJWK(ec.publicKey)), kid: "apple-ec", alg: "ES256", use: "sig" },
    ],
  };
  const codes = new Map<string, { idToken: string; redirectUri: string }>();
  const tokenCalls: FakeApple["tokenCalls"] = [];
  let n = 0;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const url = new URL(req.url!, "http://x");
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/auth/keys" && req.method === "GET") return send(200, jwks);
    if (url.pathname === "/auth/token" && req.method === "POST") {
      const fail = (reason: string, status = 400) => {
        tokenCalls.push({ ok: false, reason });
        return send(status, { error: reason });
      };
      if (body.client_id !== clientId) return fail("invalid_client");
      let secretClaims: Record<string, unknown>;
      let secretHeader: Record<string, unknown>;
      try {
        const v = await jwtVerify(body.client_secret ?? "", dev.publicKey, { issuer: teamId, audience: "https://appleid.apple.com", subject: clientId, algorithms: ["ES256"] });
        secretClaims = v.payload as Record<string, unknown>;
        secretHeader = v.protectedHeader as Record<string, unknown>;
        if (secretHeader.kid !== keyId) return fail("invalid_client");
      } catch {
        return fail("invalid_client");
      }
      if (body.grant_type !== "authorization_code") return fail("unsupported_grant_type");
      const c = codes.get(body.code ?? "");
      if (!c) return fail("invalid_grant");
      codes.delete(body.code!);
      if (body.redirect_uri !== c.redirectUri) return fail("invalid_grant");
      tokenCalls.push({ ok: true, secretClaims, secretHeader });
      return send(200, { access_token: "a.t", token_type: "Bearer", expires_in: 3600, refresh_token: "r.t", id_token: c.idToken });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url: base,
    clientId,
    teamId,
    keyId,
    privateKeyPem,
    tokenCalls,
    authorize: async (authUrl, user, opts = {}) => {
      const p = new URL(authUrl).searchParams;
      if (!authUrl.startsWith(`${base}/auth/authorize?`)) throw new Error(`unexpected authorize endpoint ${authUrl}`);
      if (p.get("client_id") !== clientId || p.get("response_type") !== "code" || p.get("response_mode") !== "form_post" || p.get("scope") !== "name email") {
        throw new Error(`bad authorize request ${authUrl}`);
      }
      const alg = opts.alg ?? "RS256";
      const key = opts.signWithUnknownKey ? rogue.privateKey : alg === "ES256" ? ec.privateKey : rsa.privateKey;
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = { nonce: opts.nonce ?? p.get("nonce"), nonce_supported: true, auth_time: now };
      if (user.email !== null) {
        claims.email = user.email ?? `${user.sub}@example.com`;
        claims.email_verified = user.emailVerified ?? "true";
      }
      if (user.isPrivateEmail !== undefined) claims.is_private_email = user.isPrivateEmail;
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg, kid: opts.signWithUnknownKey ? "apple-rsa" : alg === "ES256" ? "apple-ec" : "apple-rsa" })
        .setIssuer(opts.iss ?? "https://appleid.apple.com")
        .setAudience(opts.aud ?? clientId)
        .setSubject(user.sub)
        .setIssuedAt(now - 5)
        .setExpirationTime(now + (opts.expiresInSec ?? 600))
        .sign(key);
      const code = `c${++n}.apple`;
      codes.set(code, { idToken, redirectUri: p.get("redirect_uri")! });
      const out: { code: string; state: string; user?: string } = { code, state: p.get("state")! };
      if (opts.firstLogin && user.name) out.user = JSON.stringify({ name: user.name, email: claims.email });
      return out;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
