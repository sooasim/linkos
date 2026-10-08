import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/Page";
import { loadActiveOrg } from "../activeOrg";
import { Members } from "./Members";

export const metadata: Metadata = { title: "멤버 · 역할" };
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const { userId, org } = await loadActiveOrg();
  if (!org) redirect("/app/org");
  return (
    <div>
      <PageHeader eyebrow={org.name} title={<>멤버 · <em>역할</em></>} back="/app/org" />
      <Members orgId={org.id} myRole={org.role} myId={userId} perms={org.permissions} />
    </div>
  );
}
