import { growth } from "@linkos/api";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { AdminConsole } from "./AdminConsole";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "관리자", robots: { index: false, follow: false } };

// F-195 매출지표 · F-188 퍼널 · F-189 바이럴 · F-187 비용 · F-181 플래그 · F-196 실험 — platform admins only
export default async function AdminPage() {
  const { userId } = await getViewer();
  if (!(await growth.isAdmin(userId))) notFound();
  return (
    <div>
      <PageHeader eyebrow="Admin" title={<>운영 <em>콘솔</em></>} />
      <AdminConsole />
    </div>
  );
}
