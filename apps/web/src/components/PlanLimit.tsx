"use client";
// F-131/F-162 seats: joins/approvals that would exceed the org's purchased seats fail with
// 402 plan_limit_reached {metric:"seats", limit, used, upgradeUrl}. Show why and where to add seats.
import { ClientError } from "@/lib/client";
import { Icon } from "./Icon";

export interface SeatLimit {
  limit: number | null;
  used: number | null;
  upgradeUrl: string | null;
}

/** The seat-limit details when `e` is a 402 plan_limit_reached for seats, else null. */
export function seatLimitOf(e: unknown): SeatLimit | null {
  if (!(e instanceof ClientError) || e.status !== 402 || e.code !== "plan_limit_reached") return null;
  const d = (e.details ?? {}) as { metric?: string; limit?: number; used?: number; upgradeUrl?: string };
  if (d.metric !== "seats") return null;
  // only follow same-origin upgrade links (the server builds them from APP_ORIGIN)
  let url: string | null = null;
  try {
    const u = new URL(d.upgradeUrl ?? "", window.location.origin);
    if (u.origin === window.location.origin) url = `${u.pathname}${u.search}`;
  } catch {
    url = null;
  }
  return { limit: typeof d.limit === "number" ? d.limit : null, used: typeof d.used === "number" ? d.used : null, upgradeUrl: url };
}

export function SeatLimitNotice({ limit, upgradeUrl, admin = true }: SeatLimit & { admin?: boolean }) {
  return (
    <div role="alert" className="rounded-2xl border border-[var(--color-ember)] p-4 text-[14px]" data-testid="seat-limit">
      <p className="flex items-center gap-2 font-semibold">
        <Icon name="people" size={16} /> 조직 좌석이 모두 찼어요{limit !== null ? ` (${limit}석)` : ""}
      </p>
      <p className="mt-1 text-[13.5px] text-[var(--fg-mute)]">
        {admin ? "좌석을 늘리면 바로 합류시킬 수 있어요." : "조직 관리자에게 좌석 추가를 요청하세요. 좌석이 늘면 다시 시도할 수 있어요."}
      </p>
      {upgradeUrl && (
        <a href={upgradeUrl} className="btn btn-signal mt-3 !min-h-10 text-[14px]" data-testid="seat-upgrade">
          <Icon name="card" size={16} /> 좌석 늘리기 · 플랜 보기
        </a>
      )}
    </div>
  );
}
