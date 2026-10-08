import type { Metadata } from "next";
import { EventDetail } from "./EventDetail";

export const metadata: Metadata = { title: "행사" };

// UX-021 Event detail (EventDetail renders the F-146 meeting list so a per-recommendation request refreshes it)
export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventDetail id={id} />;
}
