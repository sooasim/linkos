import { meeting } from "@linkos/api";
import type { Metadata } from "next";
import { getViewer } from "@/lib/server";
import { MeetingEditor } from "../MeetingEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "미팅 카드" };

// UX-016 Meeting Card + UX-015 녹음 동의 + UX-019 Meeting Prep
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId } = await getViewer();
  const m = await meeting.getMeeting(userId!, id);
  return <MeetingEditor meeting={JSON.parse(JSON.stringify(m))} preselect={[]} />;
}
