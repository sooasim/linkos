// share kit — X-001 email signature · X-004 wallet passes · X-007 event poster / table tent (PDF).
// Everything is built from the owner's Living Card projected at the exchange audience (field ACL respected:
// trusted/partner/private fields never leave), so nothing here can expose more than an exchange already does.
import { createHash } from "node:crypto";
import {
  EXCHANGE_AUDIENCE,
  type PassCard,
  type PosterSize,
  type ShareCard,
  buildApplePassJson,
  buildEmailSignatures,
  buildGoogleGenericObject,
  formatShortCode,
  passManifest,
  posterLayout,
  trackedCardUrl,
  validateApplePassJson,
} from "@linkos/domain";
import { one, pool } from "../lib/db";
import { ApiError, badRequest, notFound, unauthorized } from "../lib/errors";
import { pdfFontPath } from "../lib/pdf";
import { normalizePem, signDetached } from "../lib/pkcs7";
import { type Ctx, appOrigin, audit } from "../lib/platform";
import { loadProfile, primaryProfileId, projectCard } from "./card";

async function myCard(userId: string, profileId?: string) {
  const pid = profileId ?? (await primaryProfileId(userId));
  if (!pid) throw new ApiError(422, "profile_required", "먼저 내 명함(Living Card)을 만들어 주세요.");
  const p = await loadProfile(pid);
  if (!p || p.userId !== userId) throw notFound("profile");
  const pub = projectCard(p, EXCHANGE_AUDIENCE);
  const f = (...types: string[]) => pub.fields.find((x) => types.includes(x.type))?.value ?? null;
  const share: ShareCard = { name: pub.name, jobTitle: pub.jobTitle, company: pub.company, headline: pub.headline, email: f("email"), phone: f("mobile", "phone"), website: f("website") };
  return { profile: p, share };
}

// ---------------------------------------------------------------- X-001

export async function emailSignatures(ctx: Ctx, profileId?: string) {
  if (!ctx.userId) throw unauthorized();
  const { profile, share } = await myCard(ctx.userId, profileId);
  const link = trackedCardUrl(appOrigin(), profile.slug, "sig");
  return { link, signatures: buildEmailSignatures(share, link) };
}

/** X-002 needs only the card text + tracked link; the PNG itself is rendered client-side (canvas). */
export async function backgroundData(ctx: Ctx, profileId?: string) {
  if (!ctx.userId) throw unauthorized();
  const { profile, share } = await myCard(ctx.userId, profileId);
  return { card: { name: share.name, jobTitle: share.jobTitle ?? null, company: share.company ?? null, headline: share.headline ?? null }, link: trackedCardUrl(appOrigin(), profile.slug, "bg") };
}

// ---------------------------------------------------------------- X-004

export interface AppleWalletEnv {
  passTypeIdentifier: string;
  teamIdentifier: string;
  certPem: string;
  keyPem: string;
  keyPassphrase?: string;
  wwdrPem: string;
}

/** PASS_CERT / PASS_KEY / WWDR (PEM or base64 PEM) + PASS_TYPE_ID + PASS_TEAM_ID; PASS_KEY_PASSPHRASE optional. */
export function appleWalletEnv(env: NodeJS.ProcessEnv = process.env): { config: AppleWalletEnv | null; missing: string[] } {
  const need = ["PASS_CERT", "PASS_KEY", "WWDR", "PASS_TYPE_ID", "PASS_TEAM_ID"] as const;
  const missing = need.filter((k) => !env[k]?.trim());
  if (missing.length) return { config: null, missing };
  return {
    config: {
      passTypeIdentifier: env.PASS_TYPE_ID!.trim(),
      teamIdentifier: env.PASS_TEAM_ID!.trim(),
      certPem: normalizePem(env.PASS_CERT!),
      keyPem: normalizePem(env.PASS_KEY!),
      keyPassphrase: env.PASS_KEY_PASSPHRASE || undefined,
      wwdrPem: normalizePem(env.WWDR!),
    },
    missing: [],
  };
}

/** GOOGLE_WALLET_ISSUER_ID + GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_KEY (service-account private key PEM). */
export function googleWalletEnv(env: NodeJS.ProcessEnv = process.env) {
  const need = ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_EMAIL", "GOOGLE_WALLET_SA_KEY"] as const;
  const missing = need.filter((k) => !env[k]?.trim());
  return { configured: missing.length === 0, missing, issuerId: env.GOOGLE_WALLET_ISSUER_ID?.trim() ?? null };
}

export function walletStatus() {
  const apple = appleWalletEnv();
  const google = googleWalletEnv();
  return { apple: { configured: !!apple.config, missing: apple.missing }, google: { configured: google.configured, missing: google.missing } };
}

async function passCard(userId: string, profileId?: string): Promise<PassCard> {
  const { profile, share } = await myCard(userId, profileId);
  return { ...share, profileId: profile.id, cardUrl: trackedCardUrl(appOrigin(), profile.slug, "wallet") };
}

/** LINKOS mark (two tilted cards) as PNG — no text, so no font dependency inside sharp. */
async function passImages(): Promise<Record<string, Buffer>> {
  const sharp = (await import("sharp")).default;
  const mark = (w: number, h: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 32 32" preserveAspectRatio="xMinYMid meet"><rect width="32" height="32" rx="7" fill="#ECE8FF"/><rect x="5" y="9" width="15" height="11" rx="3" fill="none" stroke="#1B1B24" stroke-width="2.2" transform="rotate(-12 12.5 14.5)"/><rect x="12" y="12" width="15" height="11" rx="3" fill="#6C5CE7" transform="rotate(8 19.5 17.5)"/></svg>`,
    );
  const png = (w: number, h: number) => sharp(mark(w, h)).png().toBuffer();
  return { "icon.png": await png(29, 29), "icon@2x.png": await png(58, 58), "logo.png": await png(50, 50), "logo@2x.png": await png(100, 100) };
}

/** Unsigned bundle (pass.json + images + manifest) — what gets signed; exposed for tests/inspection. */
export async function buildPassBundle(card: PassCard, cfg: { passTypeIdentifier: string; teamIdentifier: string }): Promise<Record<string, Buffer>> {
  const passJson = buildApplePassJson(card, cfg, `linkos-${card.profileId}`);
  const errs = validateApplePassJson(passJson);
  if (errs.length) throw new ApiError(500, "pass_invalid", `pass.json 검증 실패: ${errs.join(", ")}`);
  const files: Record<string, Buffer> = { "pass.json": Buffer.from(JSON.stringify(passJson, null, 2)), ...(await passImages()) };
  const manifest = passManifest(files, (b) => createHash("sha1").update(b).digest("hex"));
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2));
  return files;
}

/** .pkpass (zip). 501 `wallet_not_configured` until the Apple certificates are configured. */
export async function applePass(ctx: Ctx, profileId?: string): Promise<{ body: Buffer; filename: string }> {
  if (!ctx.userId) throw unauthorized();
  const { config, missing } = appleWalletEnv();
  if (!config) throw new ApiError(501, "wallet_not_configured", "Apple Wallet 서명 인증서가 설정되지 않았습니다.", { missing });
  const card = await passCard(ctx.userId, profileId);
  const files = await buildPassBundle(card, config);
  files.signature = signDetached(files["manifest.json"]!, { certPem: config.certPem, keyPem: config.keyPem, keyPassphrase: config.keyPassphrase, chainPem: [config.wwdrPem] });
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await audit(pool(), ctx, "wallet.apple_pass_issued", "profile", card.profileId);
  return { body, filename: "linkos-card.pkpass" };
}

/** Google Wallet generic object (+ signed "Save to Google Wallet" link when the service account is configured). */
export async function googleWallet(ctx: Ctx, profileId?: string) {
  if (!ctx.userId) throw unauthorized();
  const env = googleWalletEnv();
  const card = await passCard(ctx.userId, profileId);
  const object = buildGoogleGenericObject(card, env.issuerId ?? "ISSUER_ID");
  if (!env.configured) return { configured: false, missing: env.missing, object, saveUrl: null };
  const { SignJWT, importPKCS8 } = await import("jose");
  const key = await importPKCS8(normalizePem(process.env.GOOGLE_WALLET_SA_KEY!), "RS256");
  const origin = appOrigin();
  const jwt = await new SignJWT({ typ: "savetowallet", origins: [origin], payload: { genericObjects: [object] } })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(process.env.GOOGLE_WALLET_SA_EMAIL!)
    .setAudience("google")
    .setIssuedAt()
    .sign(key);
  await audit(pool(), ctx, "wallet.google_link_issued", "profile", card.profileId);
  return { configured: true, missing: [], object, saveUrl: `https://pay.google.com/gp/v/save/${jwt}` };
}

// ---------------------------------------------------------------- X-007

/**
 * Printable poster / table tent for a group exchange session (short code hero, small QR fallback, CLAUDE.md rule 3).
 * The poster only carries the short code/short URL — the long exchange token is never printed (it is not stored).
 */
export async function eventPoster(ctx: Ctx, sessionId: string, size: PosterSize): Promise<{ body: Buffer; filename: string; shortCode: string; expiresAt: string }> {
  if (!ctx.userId) throw unauthorized();
  const s = await one<{ sender_profile_id: string; short_code: string | null; short_code_expires_at: Date | null; is_group: boolean; state: string; context: Record<string, any> }>(
    "SELECT sender_profile_id, short_code, short_code_expires_at, is_group, state, context FROM exchange_sessions WHERE id=$1 AND sender_user_id=$2",
    [sessionId, ctx.userId],
  );
  if (!s) throw notFound("exchange");
  if (!s.is_group) throw badRequest("group_required", "포스터는 여러 사람이 쓰는 그룹 교환에서만 만들 수 있어요.");
  if (!s.short_code || !s.short_code_expires_at || s.short_code_expires_at.getTime() < Date.now() || ["REVOKED", "CANCELLED", "EXPIRED"].includes(s.state)) {
    throw new ApiError(410, "short_code_expired", "단축코드가 만료되었습니다. 새 그룹 교환을 시작하세요.");
  }
  const { share } = await myCard(ctx.userId, s.sender_profile_id);
  const shortUrl = `${appOrigin()}/c/${s.short_code}`;
  const L = posterLayout(size);

  const QR = (await import("qrcode")).default;
  const qr = QR.create(shortUrl, { errorCorrectionLevel: "M" });
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: [L.w, L.h], margin: 0, info: { Title: `${share.name} · LINKOS`, Creator: "LINKOS", Producer: "LINKOS" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("ko", pdfFontPath("Regular"));
  doc.registerFont("ko-bold", pdfFontPath("SemiBold"));
  const inner = L.w - L.margin * 2;
  // porcelain background + pastel blobs (print-friendly: light inks only)
  doc.rect(0, 0, L.w, L.h).fill("#FCFCFE");
  doc.circle(L.w * 0.92, L.h * 0.06, L.w * 0.42).fillOpacity(0.9).fill("#ECE8FF");
  doc.circle(L.w * 0.04, L.h * 0.98, L.w * 0.38).fillOpacity(0.9).fill("#DCF5EA");
  doc.fillOpacity(1);
  doc.font("ko-bold").fontSize(L.roleSize).fillColor("#5B4BD6").text("LINKOS · 명함 교환", L.margin, L.margin, { width: inner });
  if (s.context?.placeLabel) doc.font("ko").fontSize(L.roleSize).fillColor("#6A6A7C").text(String(s.context.placeLabel).slice(0, 60), L.margin, L.margin + L.roleSize * 1.6, { width: inner });
  doc.font("ko-bold").fontSize(L.nameSize).fillColor("#1B1B24").text(share.name, L.margin, L.h * 0.2, { width: inner });
  const role = [share.jobTitle, share.company].filter(Boolean).join(" · ");
  if (role) doc.font("ko").fontSize(L.roleSize * 1.2).fillColor("#6A6A7C").text(role, { width: inner });
  doc.font("ko").fontSize(L.roleSize).fillColor("#6A6A7C").text("휴대폰으로 아래 주소를 열고 코드를 입력하세요", L.margin, L.codeLabelY, { width: inner, align: "center" });
  doc.roundedRect(L.margin, L.codeY - L.codeSize * 0.12, inner, L.codeSize * 1.25, 14).fill("#ECE8FF");
  doc.font("ko-bold").fontSize(L.codeSize).fillColor("#1B1B24").text(formatShortCode(s.short_code), L.margin, L.codeY, { width: inner, align: "center", characterSpacing: L.codeSize * 0.06 });
  doc.font("ko-bold").fontSize(L.urlSize).fillColor("#5B4BD6").text(`${appOrigin().replace(/^https?:\/\//, "")}/c`, L.margin, L.urlY, { width: inner, align: "center" });
  // QR: small fallback in the corner
  const n = qr.modules.size;
  const cell = L.qr.size / (n + 2);
  doc.rect(L.qr.x, L.qr.y, L.qr.size, L.qr.size).fill("#FFFFFF");
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(L.qr.x + (c + 1) * cell, L.qr.y + (r + 1) * cell, cell, cell).fill("#1B1B24");
  doc.font("ko").fontSize(L.roleSize * 0.75).fillColor("#6A6A7C").text("카메라가 편하면 QR", L.margin, L.qr.y + L.qr.size - L.roleSize, { width: inner - L.qr.size - 8, align: "right" });
  const until = s.short_code_expires_at.toISOString().slice(0, 16).replace("T", " ");
  doc.font("ko").fontSize(L.roleSize * 0.7).fillColor("#6A6A7C").text(`코드 유효: ${until} UTC까지`, L.margin, L.h - L.margin - L.roleSize * 0.7, { width: inner - L.qr.size - 8 });
  doc.end();
  const body = await done;
  await audit(pool(), ctx, "poster.generated", "exchange_session", sessionId, { size });
  return { body, filename: `linkos-poster-${size}.pdf`, shortCode: s.short_code, expiresAt: s.short_code_expires_at.toISOString() };
}
