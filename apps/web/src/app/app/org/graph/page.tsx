import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Empty, PageHeader } from "@/components/Page";
import { loadActiveOrg } from "../activeOrg";
import { OrgGraph } from "./OrgGraph";

export const metadata: Metadata = { title: "관계 그래프" };
export const dynamic = "force-dynamic";

export default async function OrgGraphPage() {
  const { org } = await loadActiveOrg();
  if (!org) redirect("/app/org");
  return (
    <div>
      <PageHeader eyebrow={org.name} title={<>관계 <em>그래프</em></>} back="/app/org" />
      {org.permissions.includes("graph.read") ? <OrgGraph orgId={org.id} /> : <Empty title="권한이 없어요" body="Viewer 역할은 관계 그래프를 볼 수 없습니다." />}
    </div>
  );
}
