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
import { getViewer } from "@/lib/server";
import { RequestAccess } from "./RequestAccess";

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
export default async function PublicProfile({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ src?: string }> }) {
  const { slug } = await params;
  const { src } = await searchParams;
  const { card: c, userId } = await load(slug);
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
          <CardViewTracker profileId={c.id}>
            <LivingCard card={c} />
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
