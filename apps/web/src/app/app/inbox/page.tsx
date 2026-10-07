import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { InboxView } from "./InboxView";

export const metadata: Metadata = { title: "알림함" };

// in-app notification center: F-033 Living Update suggestions, F-036 Action Card requests, lead assignments, billing
export default function InboxPage() {
  return (
    <div>
      <PageHeader eyebrow="Inbox" title={<>알림 · <em>요청</em></>} />
      <InboxView />
    </div>
  );
}
