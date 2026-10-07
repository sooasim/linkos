import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Empty, PageHeader } from "@/components/Page";
import { loadActiveOrg } from "../activeOrg";
import { OrgSettings } from "./OrgSettings";

export const metadata: Metadata = { title: "조직 설정" };
export const dynamic = "force-dynamic";

export default async function OrgSettingsPage() {
  const { org } = await loadActiveOrg();
  if (!org) redirect("/app/org");
  return (
    <div>
      <PageHeader eyebrow={org.name} title={<>조직 <em>설정</em></>} back="/app/org" />
      {org.permissions.includes("org.update") ? <OrgSettings org={org} /> : <Empty title="권한이 없어요" body="조직 설정은 Owner/Admin만 변경할 수 있습니다." />}
    </div>
  );
}
