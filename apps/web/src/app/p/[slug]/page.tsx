import { ApiError, card, cardViews, living } from "@linkos/api";
import { contrastText } from "@linkos/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Icon";
import { ActionCtas } from "@/components/ActionCtas";
import { LivingCard } from "@/components/LivingCard";
import { ProfileMediaGallery } from "@/components/ProfileMedia";
import { headers } from "next/headers";
import { CardViewTracker } from "@/components/CardViewTracker";
import { applyPublicTranslation, isTranslationLang, publicLangs } from "@/lib/cardTranslation";
import { getViewer } from "@/lib/server";
import { RequestAccess } from "./RequestAccess";

// F-112: viewer-side language pick for cards that have owner-reviewed translations. Plain links (?lang=) — no JS.
const LANG_NAME = { en: "English", ja: "日本語" } as const;
const MT_LABEL = { en: "AI translation · reviewed by the owner", ja: "AI翻訳 · 本人確認済み" } as const;
const OWNER_LABEL = { en: "Translated by the owner", ja: "本人による翻訳" } as const;

export const dynamic = "force-dynamic";

function decode(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

async function load(rawSlug: string) {
  const slug = decode(rawSlug);
  const { userId } = await getViewer();
  try {
    return { card: await card.getPublicProfileBySlug(slug, userId), userId };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { card: c } = await load(slug);
  return { title: `${c.name}${c.company ? ` · ${c.company}` : ""}`, description: c.headline ?? c.bioShort ?? undefined };
}

// 공개 Living Card (ACL: public; 관계가 있으면 business, 승인되면 trusted)
export default async function PublicProfile({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ src?: string; lang?: string }> }) {
  const { slug } = await params;
  const { src, lang } = await searchParams;
  const { card: c, userId } = await load(slug);
  const langs = publicLangs(c.translations);
  const picked = isTranslationLang(lang) && langs.includes(lang) ? lang : null;
  const shown = picked ? applyPublicTranslation(c, c.translations?.[picked]) : { card: c, applied: false };
  // X-003: view counter + tracked-link source (signature / virtual background / wallet pass). Counts only, no viewer id.
  const h = await headers();
  const privacy = { viewerUserId: userId, gpc: h.get("sec-gpc"), dnt: h.get("dnt") };
  await cardViews.recordView({ profileId: c.id, kind: "view", ...privacy }).catch(() => false);
  const linkKind = src === "sig" ? "link_sig" : src === "bg" ? "link_bg" : src === "wallet" ? "link_wallet" : null;
  if (linkKind) await cardViews.recordView({ profileId: c.id, kind: linkKind, ...privacy }).catch(() => false);
  const actions = (await living.getActionCtas(c.id).catch(() => null))?.actions ?? [];
  return (
    <main className="stage-ink grain min-h-dvh px-5 pb-16 pt-5">
      <div aria-hidden className="marks" />
      <div className="mx-auto max-w-[520px]">
        <header className="flex items-center justify-between">
          <Link href="/"><Logo /></Link>
          {!userId && <Link href="/login" className="btn btn-ghost !min-h-10 text-[14px]">로그인</Link>}
        </header>
        <div className="mt-8 animate-rise">
          {c.brand && (
            // F-138 org branding on member cards (logo shown only as an inline data: image — CSP blocks third-party images)
            <div className="mb-3 flex items-center gap-2 rounded-2xl px-3 py-2 text-[13px] font-semibold" style={{ background: c.brand.primaryColor ?? "var(--bg-elev)", color: c.brand.primaryColor ? contrastText(c.brand.primaryColor) : "var(--fg)" }}>
              {c.brand.logoUrl?.startsWith("data:image/") && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.brand.logoUrl} alt="" width={20} height={20} className="rounded" />
              )}
              <span>{c.brand.orgName}</span>
            </div>
          )}
          {langs.length > 0 && (
            <nav aria-label="Language · 언어" className="mb-3 flex flex-wrap items-center gap-2 text-[13px]" data-testid="card-lang-picker">
              <Link href={`/p/${encodeURIComponent(c.slug)}`} aria-current={!picked ? "true" : undefined} lang="ko" className={`chip ${!picked ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>원문</Link>
              {langs.map((l) => (
                <Link key={l} href={`/p/${encodeURIComponent(c.slug)}?lang=${l}`} aria-current={picked === l ? "true" : undefined} lang={l} className={`chip ${picked === l ? "!border-transparent !bg-[var(--fg)] !text-[var(--bg)]" : ""}`}>
                  {LANG_NAME[l]}
                </Link>
              ))}
              {picked && shown.applied && (c.translations?.[picked]?.provenance === "ai_inferred" ? <span className="chip chip-ai" lang={picked}>{MT_LABEL[picked]}</span> : <span className="chip" lang={picked}>{OWNER_LABEL[picked]}</span>)}
            </nav>
          )}
          <CardViewTracker profileId={c.id}>
            <div lang={picked ?? undefined}>
              <LivingCard card={shown.card} locale={picked ?? "ko"} />
            </div>
          </CardViewTracker>
        </div>
        <ProfileMediaGallery profileId={c.id} />
        {c.hiddenFields > 0 && <RequestAccess profileId={c.id} signedIn={!!userId} />}
        <CardViewTracker profileId={c.id}>
          <ActionCtas profileId={c.id} ownerName={c.name} actions={actions} />
        </CardViewTracker>
      </div>
    </main>
  );
}
