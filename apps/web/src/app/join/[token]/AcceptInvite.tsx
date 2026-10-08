"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type SeatLimit, SeatLimitNotice, seatLimitOf } from "@/components/PlanLimit";
import { api } from "@/lib/client";

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seats, setSeats] = useState<SeatLimit | null>(null);
  const accept = async () => {
    setBusy(true);
    setErr(null);
    setSeats(null);
    try {
      const r = await api<{ orgId: string }>(`/invites/${token}`, { body: {} });
      await api("/orgs/active", { body: { orgId: r.orgId } });
      router.replace("/app/org");
    } catch (e) {
      // F-131: the org has no free seat → explain + point the admin link (joiner is usually not the admin)
      const s = seatLimitOf(e);
      if (s) setSeats(s);
      else setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn btn-signal btn-lg mt-8 w-full" onClick={accept} disabled={busy}>{busy ? "합류 중…" : "합류하기"}</button>
      {seats && <div className="mt-4"><SeatLimitNotice {...seats} admin={false} /></div>}
      {err && <p role="alert" className="mt-4 text-[14px] text-[var(--color-ember)]">{err}</p>}
    </>
  );
}
