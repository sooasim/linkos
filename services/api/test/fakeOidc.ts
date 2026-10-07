// Minimal OIDC identity provider for F-008 tests: discovery, JWKS, PKCE-checked token endpoint, RS256 id_tokens.
import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface FakeOidc {
  issuer: string;
  /** Simulate the user authenticating at the IdP for a given authorize URL; returns the code + state to send to the callback. */
  authorize: (authUrl: string, user: { sub: string; email: string; name?: string; emailVerified?: boolean }, opts?: { nonceOverride?: string; audOverride?: string; signWithOtherKey?: boolean }) => Promise<{ code: string; state: string }>;
  calls: { path: string; body: any }[];
  close: () => Promise<void>;
}

export async function startFakeOidc(clientId: string, clientSecret: string): Promise<FakeOidc> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { idToken: string; challenge: string; redirectUri: string }>();
  const calls: FakeOidc["calls"] = [];
  let issuer = "";
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? Object.fromEntries(new URLSearchParams(raw)) : null;
    const url = new URL(req.url!, "http://x");
    calls.push({ path: url.pathname, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"] });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      const c = codes.get(body?.code ?? "");
      if (!c) return send(400, { error: "invalid_grant" });
      codes.delete(body!.code!);
      if (body!.client_id !== clientId || body!.client_secret !== clientSecret) return send(401, { error: "invalid_client" });
      const s256 = createHash("sha256").update(body!.code_verifier ?? "").digest("base64url");
      if (s256 !== c.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (body!.redirect_uri !== c.redirectUri) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "at", token_type: "Bearer", id_token: c.idToken, expires_in: 300 });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer,
    calls,
    authorize: async (authUrl, user, opts = {}) => {
      const u = new URL(authUrl);
      const p = u.searchParams;
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") throw new Error("bad authorize request");
      const idToken = await new SignJWT({ email: user.email, email_verified: user.emailVerified ?? true, name: user.name, nonce: opts.nonceOverride ?? p.get("nonce") })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setSubject(user.sub)
        .setAudience(opts.audOverride ?? clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(opts.signWithOtherKey ? other.privateKey : privateKey);
      const code = `code-${++n}`;
      codes.set(code, { idToken, challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")! });
      return { code, state: p.get("state")! };
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
