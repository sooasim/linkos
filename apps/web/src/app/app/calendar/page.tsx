import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { CalendarHub } from "./CalendarHub";

export const metadata: Metadata = { title: "일정" };

// F-108 일정 승인 · F-107 예약 링크 · F-118/F-119 캘린더 연동 · ICS
export default function CalendarPage() {
  return (
    <div>
      <PageHeader eyebrow="Scheduling" title={<>일정 · <em>예약</em></>} />
      <CalendarHub />
    </div>
  );
}
