import type { Metadata } from "next";
import { Room } from "./Room";

export const metadata: Metadata = { title: "Connection Room" };

// UX-020 Connection Room
export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Room renders the meeting proposals (RoomMeeting) only once the room loaded — no stray widgets on an error page
  return <Room id={id} />;
}
