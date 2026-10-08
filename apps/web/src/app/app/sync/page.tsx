import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { SyncCenter } from "./SyncCenter";

export const metadata: Metadata = { title: "동기화" };

// F-179 재동기화 · 충돌 해결 / F-052·F-150·F-178 오프라인 큐 상태
export default function SyncPage() {
  return (
    <div>
      <PageHeader back="/app" eyebrow="Offline · Sync" title={<>동기화 <em>대기열</em></>} />
      <SyncCenter />
    </div>
  );
}
