import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/Page";
import { loadActiveOrg } from "../org/activeOrg";
import { TeamBook } from "./TeamBook";

export const metadata: Metadata = { title: "팀 주소록" };
export const dynamic = "force-dynamic";

// F-131 팀 주소록 (개인/팀 scope 분리)
export default async function TeamPage() {
  const { userId, org } = await loadActiveOrg();
  return (
    <div>
      <PageHeader eyebrow={org?.name ?? "Team"} title={<>팀 <em>주소록</em></>} />
      {org ? (
        <TeamBook orgId={org.id} myId={userId} perms={org.permissions} />
      ) : (
        <Empty title="조직 워크스페이스가 아니에요" body="팀 주소록은 조직을 선택했을 때만 보입니다. 개인 연락처는 언제나 나만 볼 수 있어요." action={<Link href="/app/org" className="btn btn-signal">조직 선택</Link>} />
      )}
    </div>
  );
}
