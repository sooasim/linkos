import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { EventsHub } from "./EventsHub";

export const metadata: Metadata = { title: "행사" };

// UX-021 Event Networking
export default function EventsPage() {
  return (
    <div>
      <PageHeader eyebrow="Events & Networking" title={<>현장에서 <em>연결</em></>} />
      <EventsHub />
    </div>
  );
}
