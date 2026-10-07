import { ApiError, card } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Icon";
import { LivingCard } from "@/components/LivingCard";
import { getViewer } from "@/lib/server";
import { RequestAccess } from "./RequestAccess";

export const dynamic = "force-dynamic";

async function load(slug: string) {
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
export default async function PublicProfile({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { card: c, userId } = await load(slug);
  return (
    <main className="stage-ink grain min-h-dvh px-5 pb-16 pt-5">
      <div className="mx-auto max-w-[520px]">
        <header className="flex items-center justify-between">
          <Link href="/"><Logo /></Link>
          {!userId && <Link href="/login" className="btn btn-ghost !min-h-10 text-[14px]">로그인</Link>}
        </header>
        <div className="mt-8 animate-rise">
          <LivingCard card={c} />
        </div>
        {c.hiddenFields > 0 && <RequestAccess profileId={c.id} signedIn={!!userId} />}
      </div>
    </main>
  );
}
