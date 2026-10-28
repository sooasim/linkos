"use client";

/**
 * 프로필 저장·발행·버전 복원.
 *
 * ## 서버 규칙을 다시 구현하지 않는다
 *
 * 길이 자르기·다듬기(sanitize)·금지 표현 판정·slug 정규화는 전부 모듈과 도메인이 한 곳에서 한다
 * (라우트 주석: 같은 규칙을 두 곳에 두면 "저장은 됐는데 공개 화면에서 다른 값"이 된다).
 * 그래서 여기서는 **보내기 전에 막지 않고**, 서버가 거절하면 그 문구를 그대로 보여 준다.
 * 브랜드 §5 금지 표현(`forbidden_claim`)도 같은 경로로 전달된다 — 화면이 금칙어 목록을 들고 있으면
 * 목록이 갈라지고, 사용자는 어느 쪽이 진짜 규칙인지 알 수 없다.
 *
 * ## 연락처 공개 (P-029)
 *
 * `showEmail`·`showPhone` 은 기본이 꺼짐이고, 켜는 행위 자체가 "별도 공개 동의"다
 * (profile.ts `SETTINGS_BOOL_KEYS` 주석). 그래서 체크하는 **그 자리에서** 무엇이 공개되는지 적고,
 * 켜진 상태에서는 경고를 유지한다. 저장 뒤에만 알려 주면 이미 공개된 다음이다.
 *
 * ## 저장 후 `router.refresh()`
 *
 * 작성 안내·버전 목록은 서버 컴포넌트가 그린다. 클라이언트가 같은 값을 다시 계산하면 서버와
 * 어긋날 수 있으므로, 저장이 끝나면 서버에 다시 그려 달라고 한다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { ClientError, api, fmtDateTime } from "@/lib/client";

/**
 * `profile.MyProfile` 과 같은 모양. 서버 모듈 타입을 직접 import 하지 않고 다시 적는 이유는
 * 클라이언트 번들에 서버 패키지 참조를 만들지 않기 위함이고, 모양이 어긋나면 **서버 페이지의
 * prop 전달 지점에서** 타입 에러가 난다(구조적 타이핑) — 조용히 갈라지지 않는다.
 */
export interface ProfileDto {
  id: string;
  slug: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  languages: string[];
  region: string | null;
  publicSettings: Record<string, unknown>;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionItem {
  version: number;
  createdAt: string | null;
  createdBy: string | null;
}

interface FormState {
  slug: string;
  displayName: string;
  headline: string;
  bio: string;
  /** 쉼표·줄바꿈 구분 입력. 배열로 바꾸는 것은 전송 직전 한 번만 한다. */
  specialties: string;
  languages: string;
  region: string;
  showRegion: boolean;
  showEmail: boolean;
  showPhone: boolean;
  ctaLabel: string;
  ctaNote: string;
}

function boolSetting(settings: Record<string, unknown>, key: string): boolean {
  return settings[key] === true;
}

function textSetting(settings: Record<string, unknown>, key: string): string {
  const v = settings[key];
  return typeof v === "string" ? v : "";
}

function toForm(p: ProfileDto | null): FormState {
  const s = p?.publicSettings ?? {};
  return {
    slug: p?.slug ?? "",
    displayName: p?.displayName ?? "",
    headline: p?.headline ?? "",
    bio: p?.bio ?? "",
    specialties: (p?.specialties ?? []).join(", "),
    languages: (p?.languages ?? []).join(", "),
    region: p?.region ?? "",
    showRegion: boolSetting(s, "showRegion"),
    showEmail: boolSetting(s, "showEmail"),
    showPhone: boolSetting(s, "showPhone"),
    ctaLabel: textSetting(s, "ctaLabel"),
    ctaNote: textSetting(s, "ctaNote"),
  };
}

/** 쉼표·줄바꿈 모두 구분자로 받는다. 개수·길이 상한은 서버가 자른다. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function orNull(raw: string): string | null {
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

type Busy = "none" | "saving" | "publishing" | "restoring";

export function ProfileEditor({ initial, versions }: { initial: ProfileDto | null; versions: VersionItem[] }) {
  const router = useRouter();
  const ids = useId();
  const [saved, setSaved] = useState<ProfileDto | null>(initial);
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [busy, setBusy] = useState<Busy>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const published = saved?.publishedAt !== null && saved?.publishedAt !== undefined;

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /** 모듈이 받는 모양 그대로. 키 allowlist(`cleanSettings`)에 없는 값은 서버가 버린다. */
  function payload(): Record<string, unknown> {
    return {
      slug: form.slug.trim(),
      displayName: form.displayName.trim(),
      headline: orNull(form.headline),
      bio: orNull(form.bio),
      specialties: splitList(form.specialties),
      languages: splitList(form.languages),
      region: orNull(form.region),
      publicSettings: {
        showRegion: form.showRegion,
        showEmail: form.showEmail,
        showPhone: form.showPhone,
        ctaLabel: orNull(form.ctaLabel),
        ctaNote: orNull(form.ctaNote),
      },
    };
  }

  async function run(kind: Busy, fn: () => Promise<string>): Promise<void> {
    if (busy !== "none") return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      // 서버가 그리는 작성 안내·버전 목록을 다시 받아 온다.
      router.refresh();
    } catch (e) {
      setError(e instanceof ClientError ? e.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy("none");
    }
  }

  function save(): Promise<void> {
    return run("saving", async () => {
      // 생성과 수정의 차이는 **프로필이 있는지**뿐이다. 경로가 둘인 이유는 라우트 주석에 적혀 있다.
      const out = saved
        ? await api<{ profile: ProfileDto }>("/me/profile", { method: "PATCH", body: payload() })
        : await api<{ profile: ProfileDto }>("/me/profile", { method: "POST", body: payload() });
      setSaved(out.profile);
      setForm(toForm(out.profile));
      return saved ? "저장했습니다." : "프로필을 만들었습니다. 내용을 확인한 뒤 발행하세요.";
    });
  }

  function publish(): Promise<void> {
    return run("publishing", async () => {
      const out = await api<{ publishedAt: string; url: string }>("/me/profile/publish", { body: {} });
      setSaved((prev) => (prev ? { ...prev, publishedAt: out.publishedAt } : prev));
      return "공개했습니다. 공개 주소에서 바로 열립니다.";
    });
  }

  function unpublish(): Promise<void> {
    return run("publishing", async () => {
      await api<{ unpublished: true }>("/me/profile/unpublish", { body: {} });
      setSaved((prev) => (prev ? { ...prev, publishedAt: null } : prev));
      return "공개를 중단했습니다. 공개 주소는 더 이상 열리지 않습니다.";
    });
  }

  function restore(version: number): Promise<void> {
    return run("restoring", async () => {
      const out = await api<{ profile: ProfileDto }>("/me/profile/versions", { body: { version } });
      setSaved(out.profile);
      setForm(toForm(out.profile));
      return `${version}번 버전의 내용으로 되돌렸습니다. 새 버전 ${out.profile.version}번으로 저장되었습니다.`;
    });
  }

  const working = busy !== "none";

  return (
    <div className="mt-8 flex flex-col gap-5">
      {/* 상태 메시지는 폼 위에 둔다 — 저장 버튼이 화면 밖에 있을 때도 결과가 보여야 한다. */}
      <div aria-live="polite" className="empty:hidden">
        {notice ? (
          <p className="panel p-4 text-[14px] font-medium">{notice}</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="card p-4 text-[14px] font-medium text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      {/* ── 공개 상태 (P-027) ──────────────────────────────── */}
      {saved ? (
        <section aria-labelledby={`${ids}-publish`} className="card flex flex-col gap-3 p-6">
          <h2 id={`${ids}-publish`} className="text-[17px] font-semibold">
            공개 상태
          </h2>
          <p className="text-[15px]">
            <span className="font-semibold">{published ? "공개 중" : "비공개"}</span>
            {" · "}
            <Link href={`/p/${saved.slug}`} className="text-[var(--accent-text)] underline underline-offset-2">
              /p/{saved.slug}
            </Link>
          </p>
          <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
            {published
              ? "지금 이 주소는 로그인 없이 열립니다. 확인이 취소되거나 기간이 지난 배지는 이 화면과 공개 페이지에서 함께 내려갑니다."
              : "비공개 상태에서는 위 주소가 열리지 않습니다. 저장한 내용은 그대로 보관됩니다."}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {published ? (
              <button type="button" className="btn btn-ghost" onClick={unpublish} disabled={working}>
                {busy === "publishing" ? "처리 중…" : "공개 중단"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={publish} disabled={working}>
                {busy === "publishing" ? "처리 중…" : "공개하기"}
              </button>
            )}
          </div>
        </section>
      ) : null}

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {/* ── 기본 정보 ───────────────────────────────────────── */}
        <section aria-labelledby={`${ids}-basic`} className="card flex flex-col gap-5 p-6">
          <h2 id={`${ids}-basic`} className="text-[17px] font-semibold">
            기본 정보
          </h2>

          <div>
            <label className="label" htmlFor={`${ids}-slug`}>
              공개 주소
            </label>
            <input
              id={`${ids}-slug`}
              className="field"
              value={form.slug}
              onChange={(e) => set("slug", e.target.value)}
              required
              maxLength={120}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="hong-gildong"
              aria-describedby={`${ids}-slug-hint`}
            />
            <p id={`${ids}-slug-hint`} className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
              주소는 <span className="font-medium text-[var(--fg)]">/p/{form.slug.trim() || "내아이디"}</span> 가 됩니다.
              주소를 바꾸면 이전 주소로 공유된 링크는 더 이상 열리지 않습니다.
            </p>
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-name`}>
              이름
            </label>
            <input
              id={`${ids}-name`}
              className="field"
              value={form.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              required
              maxLength={80}
              autoComplete="name"
            />
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-headline`}>
              한 줄 소개
            </label>
            <input
              id={`${ids}-headline`}
              className="field"
              value={form.headline}
              onChange={(e) => set("headline", e.target.value)}
              maxLength={120}
              placeholder="의료기기 유통 · 수술실 장비 도입 상담"
              aria-describedby={`${ids}-claim-hint`}
            />
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-bio`}>
              상세 소개
            </label>
            <textarea
              id={`${ids}-bio`}
              className="field min-h-40"
              value={form.bio}
              onChange={(e) => set("bio", e.target.value)}
              maxLength={2000}
              rows={8}
              aria-describedby={`${ids}-claim-hint`}
            />
            <p id={`${ids}-claim-hint`} className="mt-2 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
              근거를 확인할 수 없는 최상급 표현(“국내 1위”, “100% 보장” 등)은 저장되지 않습니다. 실적은 확인
              가능한 수치로 검증 화면에서 올리세요.
            </p>
          </div>
        </section>

        {/* ── 전문 분야 · 언어 · 지역 ─────────────────────────── */}
        <section aria-labelledby={`${ids}-detail`} className="card flex flex-col gap-5 p-6">
          <h2 id={`${ids}-detail`} className="text-[17px] font-semibold">
            전문 분야 · 언어 · 지역
          </h2>

          <div>
            <label className="label" htmlFor={`${ids}-specialties`}>
              전문 분야
            </label>
            <input
              id={`${ids}-specialties`}
              className="field"
              value={form.specialties}
              onChange={(e) => set("specialties", e.target.value)}
              placeholder="내시경 장비, 병원 인증 컨설팅"
              aria-describedby={`${ids}-specialties-hint`}
            />
            <p id={`${ids}-specialties-hint`} className="mt-2 text-[12.5px] text-[var(--fg-mute)]">
              쉼표로 구분합니다. 최대 12개까지 저장되고 같은 값은 한 번만 남습니다.
            </p>
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-languages`}>
              사용 언어
            </label>
            <input
              id={`${ids}-languages`}
              className="field"
              value={form.languages}
              onChange={(e) => set("languages", e.target.value)}
              placeholder="한국어, 영어"
            />
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-region`}>
              활동 지역
            </label>
            <input
              id={`${ids}-region`}
              className="field"
              value={form.region}
              onChange={(e) => set("region", e.target.value)}
              maxLength={60}
              placeholder="서울"
            />
          </div>
        </section>

        {/* ── 공개 설정 (P-029) ──────────────────────────────── */}
        <section aria-labelledby={`${ids}-visibility`} className="card flex flex-col gap-4 p-6">
          <h2 id={`${ids}-visibility`} className="text-[17px] font-semibold">
            공개 설정
          </h2>
          <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
            연락처는 기본적으로 숨겨집니다. 아래를 켜면 공개 프로필과 vCard 에 그대로 표시되고, 변경 시점이
            기록됩니다.
          </p>

          <label className="flex items-start gap-3 text-[14.5px]">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              checked={form.showRegion}
              onChange={(e) => set("showRegion", e.target.checked)}
            />
            <span>
              활동 지역 공개
              <span className="mt-0.5 block text-[12.5px] text-[var(--fg-mute)]">
                끄면 공개 페이지에서 지역이 보이지 않습니다.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-[14.5px]">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              checked={form.showEmail}
              onChange={(e) => set("showEmail", e.target.checked)}
            />
            <span>
              이메일 공개
              <span className="mt-0.5 block text-[12.5px] text-[var(--fg-mute)]">
                켜면 계정 이메일이 공개 페이지에 그대로 표시됩니다.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-[14.5px]">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              checked={form.showPhone}
              onChange={(e) => set("showPhone", e.target.checked)}
            />
            <span>
              전화번호 공개
              <span className="mt-0.5 block text-[12.5px] text-[var(--fg-mute)]">
                켜면 등록된 전화번호가 공개 페이지에 그대로 표시됩니다.
              </span>
            </span>
          </label>

          {/* 켜 둔 상태에서도 경고가 남아 있어야 한다 — 저장 뒤에만 알리면 이미 공개된 다음이다. */}
          {form.showEmail || form.showPhone ? (
            <p role="status" className="panel p-4 text-[13px] leading-relaxed text-[var(--caution)]">
              {form.showEmail && form.showPhone
                ? "이메일과 전화번호가 공개 프로필에 표시됩니다."
                : form.showEmail
                  ? "이메일이 공개 프로필에 표시됩니다."
                  : "전화번호가 공개 프로필에 표시됩니다."}{" "}
              저장하면 즉시 적용되고, 변경 사실이 기록에 남습니다.
            </p>
          ) : null}

          <hr className="rule" />

          <div>
            <label className="label" htmlFor={`${ids}-cta`}>
              상담 버튼 문구
            </label>
            <input
              id={`${ids}-cta`}
              className="field"
              value={form.ctaLabel}
              onChange={(e) => set("ctaLabel", e.target.value)}
              maxLength={40}
              placeholder="상담 요청하기"
            />
          </div>

          <div>
            <label className="label" htmlFor={`${ids}-cta-note`}>
              상담 버튼 안내 문구
            </label>
            <textarea
              id={`${ids}-cta-note`}
              className="field min-h-20"
              value={form.ctaNote}
              onChange={(e) => set("ctaNote", e.target.value)}
              maxLength={300}
              rows={3}
              placeholder="평일 09–18시에 확인합니다."
            />
          </div>
        </section>

        {/* 주요 행동은 한 손 엄지에 닿는 아래쪽에 둔다 (브랜드 §7 모바일 우선). */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button type="submit" className="btn btn-primary btn-lg w-full sm:w-auto" disabled={working}>
            {busy === "saving" ? "저장 중…" : saved ? "저장" : "프로필 만들기"}
          </button>
          <p className="text-[12.5px] text-[var(--fg-mute)]">
            저장할 때마다 버전이 하나 생깁니다. 공개 여부는 저장과 별개입니다.
          </p>
        </div>
      </form>

      {/* ── 버전 (P-028) ───────────────────────────────────── */}
      {saved ? (
        <section aria-labelledby={`${ids}-versions`} className="card flex flex-col gap-3 p-6">
          <h2 id={`${ids}-versions`} className="text-[17px] font-semibold">
            저장 이력
          </h2>
          <p className="text-[13px] leading-relaxed text-[var(--fg-mute)]">
            되돌리기는 과거 버전을 덮어쓰지 않고 새 버전을 하나 더 만듭니다. <strong>공개 주소(slug)는
            되돌리지 않습니다</strong> — 과거 주소가 이미 다른 사람에게 발급됐을 수 있기 때문입니다.
          </p>

          {versions.length === 0 ? (
            <p className="text-[14px] text-[var(--fg-mute)]">저장 이력이 없습니다.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--line)]">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="text-[14px]">
                    <span className="font-semibold tabular-nums">{v.version}번</span>
                    {v.createdAt ? (
                      <span className="text-[var(--fg-mute)]"> · {fmtDateTime(v.createdAt)}</span>
                    ) : null}
                    {v.version === saved.version ? (
                      <span className="text-[var(--fg-mute)]"> · 현재 내용</span>
                    ) : null}
                  </span>
                  {v.version === saved.version ? null : (
                    <button
                      type="button"
                      className="btn btn-ghost !min-h-10 text-[14px]"
                      onClick={() => void restore(v.version)}
                      disabled={working}
                      aria-label={`${v.version}번 버전의 내용으로 되돌리기`}
                    >
                      {busy === "restoring" ? "처리 중…" : "되돌리기"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
