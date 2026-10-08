import { redirect } from "next/navigation";
import { Dock, SideNav } from "@/components/Dock";
import { identity } from "@linkos/api";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await getViewer();
  if (!userId) redirect("/login?next=/app");
  return (
    <div className="stage-aurora flex min-h-dvh">
      <div aria-hidden className="marks" />
      <SideNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-36 pt-6 sm:px-8 lg:pb-16 lg:pt-10">
        {identity.demoLoginEnabled() && (
          <p role="note" className="mb-4 rounded-2xl bg-[var(--color-butter)] px-4 py-2 text-[13px] text-[var(--color-ink)]" data-testid="test-server-note">
            테스트 서버입니다. 실제 개인정보를 넣지 마세요. 데이터는 예고 없이 지워질 수 있어요.
          </p>
        )}
        {children}
      </main>
      <Dock />
    </div>
  );
}
