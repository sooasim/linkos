import { redirect } from "next/navigation";
import { Dock, SideNav } from "@/components/Dock";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await getViewer();
  if (!userId) redirect("/login?next=/app");
  return (
    <div className="stage-aurora flex min-h-dvh">
      <div aria-hidden className="marks" />
      <SideNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-36 pt-6 sm:px-8 lg:pb-16 lg:pt-10">{children}</main>
      <Dock />
    </div>
  );
}
