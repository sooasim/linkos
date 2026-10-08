import { redirect } from "next/navigation";
import { Dock, SideNav } from "@/components/Dock";
import { identity } from "@linkos/api";
import { getMessages } from "@/lib/i18n.server";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await getViewer();
  if (!userId) redirect("/login?next=/app");
  const { m } = await getMessages();
  return (
    <div className="stage-aurora flex min-h-dvh">
      <div aria-hidden className="marks" />
      <SideNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-36 pt-6 sm:px-8 lg:pb-16 lg:pt-10">
        {identity.demoLoginEnabled() && (
          <p role="note" className="mb-4 rounded-2xl bg-[var(--color-butter)] px-4 py-2 text-[13px] text-[var(--color-ink)]" data-testid="test-server-note">
            {m.nav.testServer}
          </p>
        )}
        {children}
      </main>
      <Dock />
    </div>
  );
}
