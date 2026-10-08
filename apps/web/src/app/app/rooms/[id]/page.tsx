import type { Metadata } from "next";
import { RoomMeeting } from "@/components/RoomMeeting";
import { Room } from "./Room";

export const metadata: Metadata = { title: "Connection Room" };

// UX-020 Connection Room
export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <Room id={id} />
      <RoomMeeting roomId={id} />
    </>
  );
}
