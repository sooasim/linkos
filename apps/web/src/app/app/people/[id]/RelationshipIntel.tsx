"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AiLabel } from "@/components/Page";
import { api } from "@/lib/client";

// S15 Relationship Intelligence (N-103 9신호 · N-104 감쇠 · N-109 활동 · N-022 공개 권한).
// 지침 §13: 점수 숫자만 보여주지 않는다 — 구성요소 + 근거 + 휴면 신호를 함께 본다.
// 기존 F-074 StrengthPanel(6신호)은 그대로 두고, 이 패널이 소개 경로 계산에 쓰이는 상위 모델을 보여준다.

interface Component {
  kind: string;
  value: number;
  weight: number;
  contribution: number;
  text: string;
  evidenceId: string | null;
}

interface Intel {
  contactId: string;
  strength: {
    score: number;
    score100: number;
    band: "strong" | "medium" | "weak";
    components: Component[];
    confidenceCap: number | null;
    stale: { isStale: boolean; daysSinceLastContact: number | null; text: string | null };
  };
  activity: {
    oneToOneCount: number;
    oneToOneCadenceDays: number | null;
    referralsGiven: number;
    referralsReceived: number;
    referralsSucceeded: number;
    testimonials: number;
    lastActivityAt: string | null;
    oneToOne: { state: string; text: string };
  };
}

const BAND: Record<string, { label: string; cls: string }> = {
  strong: { label: "강함", cls: "bg-[var(--color-mint)] text-[var(--color-ink)]" },
  medium: { label: "보통", cls: "bg-[var(--color-butter)] text-[var(--color-ink)]" },
  weak: { label: "약함", cls: "bg-[var(--bg-sunk)] text-[var(--fg-mute)]" },
};

const SHARE_OPTIONS: { value: string; label: string; help: string }[] = [
  { value: "none", label: "공유 안 함", help: "다른 사용자의 후보 목록에 전혀 나타나지 않습니다." },
  { value: "path_only", label: "경로만", help: "신원을 가린 채 후보로 나타나고 소개 요청을 받을 수 있습니다." },
  { value: "profile", label: "프로필까지", help: "이름·회사까지 공개됩니다. 연락처는 공개되지 않습니다." },
  { value: "contact", label: "소개 후 연락처", help: "양측이 소개에 동의하면 연락처까지 공개됩니다." },
  { value: "introduction", label: "소개 적극 허용", help: "소개 요청을 적극적으로 받습니다. 연락처는 소개 승인 후 공개됩니다." },
];

const ACTIVITY_OPTIONS = [
  { value: "one_to_one", label: "1:1 미팅" },
  { value: "referral_given", label: "소개를 해 줌" },
  { value: "referral_received", label: "소개를 받음" },
  { value: "testimonial", label: "추천사" },
  { value: "group_meeting", label: "그룹 미팅" },
  { value: "follow_up", label: "후속 연락" },
];

export function RelationshipIntel({ id }: { id: string }) {
  const [intel, setIntel] = useState<Intel | null>(null);
  const [share, setShare] = useState<{ sharePermission: string; discoveryOptOut: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logging, setLogging] = useState(false);
  const [form, setForm] = useState({ activityType: "one_to_one", durationMinutes: "60", outcome: "" });

  const load = useCallback(async () => {
    const [i, s] = await Promise.all([
      api<Intel>(`/network-intel/relationships/${id}`).catch(() => null),
      api<{ sharePermission: string; discoveryOptOut: boolean }>(`/network-intel/share-permissions/${id}`).catch(() => null),
    ]);
    if (i) setIntel(i);
    if (s) setShare(s);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!intel) return null;
  const { strength, activity } = intel;
  const band = BAND[strength.band]!;

  return (
    <section className="surface mt-4 space-y-4 p-4" aria-label="관계 인텔리전스">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">관계 인텔리전스</p>
          <p className="mt-1 flex items-center gap-2">
            <span className="text-[30px] font-semibold leading-none tabular-nums">{strength.score100}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${band.cls}`}>{band.label}</span>
            <AiLabel>9개 신호 기반</AiLabel>
          </p>
        </div>
        <Link className="btn btn-ghost !min-h-10" href={`/app/network/paths/${id}`}>
          <Icon name="share" size={16} aria-hidden />
          소개 경로
        </Link>
      </div>

      {strength.stale.text && (
        <p className={`rounded-2xl px-3 py-2 text-[12.5px] ${strength.stale.isStale ? "bg-[var(--color-butter)] text-[var(--color-ink)]" : "bg-[var(--bg-sunk)] text-[var(--fg-mute)]"}`}>
          <Icon name="bolt" size={14} className="mr-1.5 inline" aria-hidden />
          {strength.stale.text}
        </p>
      )}
      {strength.confidenceCap != null && (
        <p className="rounded-2xl bg-[var(--bg-sunk)] px-3 py-2 text-[12.5px] text-[var(--fg-mute)]">
          추정된 관계라 점수 상한 {Math.round(strength.confidenceCap * 100)}점이 적용되었습니다. 관계를 확인하면 상한이 풀립니다.
        </p>
      )}

      <div>
        <p className="label">신호별 기여도</p>
        <ul className="space-y-1.5">
          {strength.components.map((c) => (
            <li key={c.kind} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[13px]">
              <span className="flex items-center gap-2">
                <span className="h-2 shrink-0 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]" style={{ width: 72 }} aria-hidden>
                  <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round(c.value * 100)}%` }} />
                </span>
                <span>{c.text}</span>
                {c.evidenceId && <Icon name="link" size={12} className="text-[var(--fg-mute)]" aria-label="근거 기록 있음" />}
              </span>
              <span className="tabular-nums text-[var(--fg-mute)]">
                +{Math.round(c.contribution * 100)} <span className="opacity-60">×{c.weight}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-2xl bg-[var(--bg-sunk)] p-3">
        <p className="label">네트워크 활동</p>
        <p className="text-[13px]">{activity.oneToOne.text}</p>
        <p className="mt-1.5 text-[12px] text-[var(--fg-mute)]">
          1:1 {activity.oneToOneCount}회 · 소개 준 {activity.referralsGiven}건 · 받은 {activity.referralsReceived}건 · 성과로 이어진 소개 {activity.referralsSucceeded}건
          {activity.testimonials > 0 && ` · 추천사 ${activity.testimonials}건`}
        </p>

        {logging ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("/network-intel/activities", {
                  body: {
                    contactId: id,
                    activityType: form.activityType,
                    durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
                    outcome: form.outcome || null,
                  },
                });
                setLogging(false);
                await load();
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="label" htmlFor="acttype">
              활동 종류
            </label>
            <select id="acttype" className="field" value={form.activityType} onChange={(e) => setForm({ ...form, activityType: e.target.value })}>
              {ACTIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {form.activityType.startsWith("referral") && (
              <>
                <label className="label" htmlFor="actoutcome">
                  결과 — 소개 성공률은 이 기록에서만 계산합니다
                </label>
                <select id="actoutcome" className="field" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
                  <option value="">아직 모름</option>
                  <option value="met">만났음</option>
                  <option value="qualified">검토 진행</option>
                  <option value="won">성사</option>
                  <option value="lost">무산</option>
                  <option value="declined">거절</option>
                </select>
              </>
            )}
            {(form.activityType === "one_to_one" || form.activityType === "group_meeting") && (
              <>
                <label className="label" htmlFor="actmin">
                  소요 시간(분)
                </label>
                <input id="actmin" className="field" type="number" min={0} max={1440} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
              </>
            )}
            <div className="flex gap-2">
              <button className="btn btn-ink !min-h-10" disabled={busy}>
                기록
              </button>
              <button type="button" className="btn btn-ghost !min-h-10" onClick={() => setLogging(false)}>
                취소
              </button>
            </div>
          </form>
        ) : (
          <button className="btn btn-ghost mt-2.5 !min-h-10" onClick={() => setLogging(true)}>
            <Icon name="plus" size={15} aria-hidden />
            활동 기록
          </button>
        )}
      </div>

      {share && (
        <div>
          <p className="label">이 연락처를 네트워크에서 어디까지 공유할까요</p>
          <select
            className="field"
            value={share.discoveryOptOut ? "none" : share.sharePermission}
            aria-label="공유 범위"
            onChange={async (e) => {
              const v = e.target.value;
              setBusy(true);
              try {
                await api(`/network-intel/share-permissions/${id}`, {
                  method: "PUT",
                  body: v === "none" ? { sharePermission: "none", discoveryOptOut: true } : { sharePermission: v, discoveryOptOut: false },
                });
                setShare({ sharePermission: v, discoveryOptOut: v === "none" });
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            {SHARE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[12px] text-[var(--fg-mute)]">
            {SHARE_OPTIONS.find((o) => o.value === (share.discoveryOptOut ? "none" : share.sharePermission))?.help}
          </p>
          <p className="mt-1 text-[12px] text-[var(--fg-mute)]">탐색·신원·연락처는 서로 다른 권한입니다. 연락처는 어떤 설정에서도 소개 승인 전에 공개되지 않습니다.</p>
        </div>
      )}

      <button
        className="btn btn-ghost !min-h-10"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/network-intel/relationships/${id}`, { method: "PATCH", body: { label: "wrong_relationship" } });
            await load();
          } finally {
            setBusy(false);
          }
        }}
      >
        이 관계 정보가 틀렸어요
      </button>
    </section>
  );
}
