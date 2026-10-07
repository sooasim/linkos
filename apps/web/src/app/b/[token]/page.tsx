import { ApiError, calendar } from "@linkos/api";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingPicker } from "./BookingPicker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "미팅 예약", robots: { index: false, follow: false } };

// F-107 캘린더 예약 — public, no login. Only the owner's display name, page title and free slots are shown.
export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let page: Awaited<ReturnType<typeof calendar.publicBookingPage>>;
  try {
    page = await calendar.publicBookingPage(token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pb-28 pt-10">
      <p className="eyebrow">{page.ownerCompany ?? "LINKOS"}</p>
      <h1 className="display mt-1.5 text-[40px] leading-tight">{page.ownerName}님과 <em>{page.title}</em></h1>
      <p className="mt-2 text-[14px] text-[var(--fg-mute)]">{page.durationMin}분{page.location ? ` · ${page.location}` : ""} · 시간대 {page.timezone}</p>
      <BookingPicker token={token} slots={page.slots} timezone={page.timezone} />
    </main>
  );
}
