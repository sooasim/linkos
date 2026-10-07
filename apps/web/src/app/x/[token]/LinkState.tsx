import Link from "next/link";
import { Logo } from "@/components/Icon";

const COPY: Record<string, { title: string; body: string }> = {
  exchange_expired: { title: "링크가 만료됐어요", body: "교환 링크는 보안을 위해 잠시만 유효합니다. 상대에게 새 링크나 코드를 요청하세요." },
  exchange_revoked: { title: "교환이 취소됐어요", body: "보낸 사람이 이 교환을 취소했습니다." },
  not_found: { title: "링크를 찾을 수 없어요", body: "주소나 코드를 다시 확인해 주세요." },
  rate_limited: { title: "잠시 후 다시 시도하세요", body: "짧은 시간에 너무 많은 요청이 있었습니다." },
};

export function LinkState({ code }: { code: string }) {
  const c = COPY[code] ?? { title: "문제가 생겼어요", body: "잠시 후 다시 시도해 주세요." };
  return (
    <main className="stage-ink grain flex min-h-dvh flex-col px-6 pb-10 pt-6">
      <Logo />
      <div className="my-auto max-w-md animate-rise">
        <p className="eyebrow">LINKOS Exchange</p>
        <h1 className="display mt-3 text-[56px]">{c.title}</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-[var(--fg-mute)]">{c.body}</p>
        <div className="mt-8 flex gap-3">
          <Link href="/c" className="btn btn-signal">코드로 받기</Link>
          <Link href="/" className="btn btn-ghost">LINKOS 알아보기</Link>
        </div>
      </div>
    </main>
  );
}
