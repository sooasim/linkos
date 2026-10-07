import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { Messages } from "./Messages";

export const metadata: Metadata = { title: "메시지" };

// F-106 이메일 발송 · F-111 템플릿 · F-105 후속 시퀀스 · F-115 Gmail
export default function MessagesPage() {
  return (
    <div>
      <PageHeader eyebrow="Communication" title={<>메시지 · <em>템플릿</em></>} />
      <Messages />
    </div>
  );
}
