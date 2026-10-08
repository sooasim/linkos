import type { Metadata } from "next";
import { MeetingEditor } from "../MeetingEditor";

export const metadata: Metadata = { title: "새 미팅" };

export default async function NewMeeting({ searchParams }: { searchParams: Promise<{ contact?: string }> }) {
  const sp = await searchParams;
  return <MeetingEditor meeting={null} preselect={sp.contact ? [sp.contact] : []} />;
}
