import type { Metadata } from "next";
import { EventMeetings } from "@/components/EventMeetings";
import { EventDetail } from "./EventDetail";

export const metadata: Metadata = { title: "행사" };

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <EventDetail id={id} />
      <EventMeetings eventId={id} />
    </>
  );
}
