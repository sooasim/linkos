import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { loadActiveOrg } from "./activeOrg";
import { OrgHub } from "./OrgHub";

export const metadata: Metadata = { title: "조직" };
export const dynamic = "force-dynamic";

// F-129 조직/워크스페이스 · F-135 활동 대시보드
export default async function OrgPage() {
  const { org } = await loadActiveOrg();
  return (
    <div>
      <PageHeader eyebrow="Organization" title={org ? <>{org.name}</> : <>조직 <em>워크스페이스</em></>} />
      <OrgHub active={org} />
    </div>
  );
}
