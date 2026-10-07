import { ApiError, org } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/Icon";
import { getViewer } from "@/lib/server";
import { AcceptInvite } from "./AcceptInvite";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "조직 초대", referrer: "no-referrer" };

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", viewer: "Viewer" };

// F-004 조직 가입 — invite link landing (token is a bearer secret; no referrer)
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { userId } = await getViewer();
  let p;
  try {
    p = await org.previewInvite(token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const color = p.branding?.primaryColor ?? null;
  return (
    <main className="stage-ink grain flex min-h-dvh flex-col px-5 pb-10 pt-5">
      <header><Link href="/"><Logo /></Link></header>
      <div className="mx-auto my-auto w-full max-w-sm animate-rise">
        {color && <span aria-hidden className="mb-4 block h-1.5 w-16 rounded-full" style={{ background: color }} />}
        <p className="eyebrow">조직 초대</p>
        <h1 className="display mt-2 text-[48px]">{p.orgName}</h1>
        <p className="mt-2 text-[15px] text-[var(--fg-mute)]">{ROLE[p.role]} 역할로 초대되었습니다.{p.emailBound ? " 초대받은 이메일로 로그인해야 합니다." : ""}</p>
        <p className="mt-3 text-[13px] text-[var(--fg-mute)]">합류해도 내 개인 연락처와 메모는 공유되지 않아요. 팀에 공유할 연락처는 직접 고릅니다.</p>
        {!p.usable ? (
          <p className="mt-6 rounded-2xl border border-[var(--line)] p-4 text-[14px]">이 초대 링크는 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하세요.</p>
        ) : userId ? (
          <AcceptInvite token={token} />
        ) : (
          <Link href={`/login?next=${encodeURIComponent(`/join/${token}`)}`} className="btn btn-signal btn-lg mt-8 w-full">로그인하고 합류</Link>
        )}
      </div>
    </main>
  );
}
