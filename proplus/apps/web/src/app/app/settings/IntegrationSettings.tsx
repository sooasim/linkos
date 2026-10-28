"use client";

/**
 * 연동 설정 — LINKOS 로의 리드 전달(05 문서 §2)과 배지 조회 허용(05 문서 §3).
 *
 * ## 왜 둘 다 기본 꺼짐인가
 *
 * 전달은 **소유자의 결정**이고 상담을 남긴 사람이 준 동의가 아니다(05 문서 §2). 조회 허용은 켜는 순간
 * "이 이메일이 PROPLUS 에 있는지"를 남이 확인할 수 있게 된다(§3). 둘 다 켜지는 쪽이 기본값이면
 * 사용자가 선택하지 않은 공개가 일어난다. 그래서 jsonb 에 키가 없을 때는 꺼짐이고, 서버도 `=== true`
 * 로만 연다.
 *
 * ## 왜 스위치 아래에 한 문장을 쓰는가
 *
 * "LINKOS 연동"이라는 라벨만으로는 **무엇이 어디로 가는지** 알 수 없다. 켠 뒤에 알게 되는 설정은
 * 선택이 아니다. 그래서 각 스위치 밑에 일어나는 일을 한 문장으로 적고, 전달되지 **않는** 것
 * (마케팅 수신 동의 여부 · 연락처 · 증빙)도 같이 적는다.
 *
 * ## 왜 즉시 저장하지 않는가
 *
 * 체크 즉시 저장하면 스크롤 중의 오클릭이 전달을 켠다. 되돌릴 수 있는 설정이지만, 켜진 사이에
 * 들어온 상담은 이미 저쪽으로 간다 — 되돌려지지 않는 쪽이다. 그래서 명시적인 저장 단계를 둔다.
 */

import { useState } from "react";
import { ClientError, api } from "@/lib/client";

/**
 * 서버 모듈(`integration.integrationSettings`)의 반환값과 같은 모양. 서버 타입을 직접 import 하지
 * 않는 이유는 `SettingsClient` 의 `SessionDto` 와 같다 — 모양이 어긋나면 서버 페이지의 prop 전달
 * 지점에서 타입 에러가 난다.
 */
export interface IntegrationSettingsDto {
  linkosSync: boolean;
  allowDirectoryLookup: boolean;
  /** 서버에 연동 주소·키가 주입돼 있는지. false 면 켤 수 있는 대상이 없다 (05 문서 §5). */
  linkosConfigured: boolean;
}

type Form = { linkosSync: boolean; allowDirectoryLookup: boolean };

export function IntegrationSettings({ initial }: { initial: IntegrationSettingsDto }) {
  const [saved, setSaved] = useState<Form>({
    linkosSync: initial.linkosSync,
    allowDirectoryLookup: initial.allowDirectoryLookup,
  });
  const [form, setForm] = useState<Form>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const locked = !initial.linkosConfigured;
  const dirty = form.linkosSync !== saved.linkosSync || form.allowDirectoryLookup !== saved.allowDirectoryLookup;

  function set<K extends keyof Form>(key: K, value: boolean): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setNotice(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (busy || locked || !dirty) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 서버가 머지하므로 두 키를 함께 보낸다. 보내지 않은 키는 "변경 없음"이다.
      await api<IntegrationSettingsDto>("/me/integration", { method: "PATCH", body: form });
      setSaved(form);
      setNotice("연동 설정을 저장했습니다.");
    } catch (e) {
      if (e instanceof ClientError && e.status === 401) {
        window.location.assign("/login?next=%2Fapp%2Fsettings");
        return;
      }
      setError(e instanceof ClientError ? e.message : "설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="h-integration" className="card flex flex-col gap-4 p-6">
      <h2 id="h-integration" className="text-[17px] font-semibold">
        LINKOS 연동
      </h2>
      <p className="text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
        LINKOS 는 같은 운영자의 연락처 관리 도구입니다. 아래 두 가지는 <b className="text-[var(--fg)]">기본적으로
        꺼져 있고</b>, 켠 사실과 전달한 사실은 기록으로 남습니다.
      </p>

      {locked ? (
        <p role="status" className="panel p-4 text-[13px] leading-relaxed text-[var(--fg-mute)]">
          서버에 연동이 설정되지 않았습니다. 설정되기 전에는 아무것도 전달되지 않으며, 이 화면에서 켤 수도
          없습니다.
        </p>
      ) : null}

      {/* ── 리드 전달 (05 문서 §2) ─────────────────────────── */}
      <label className="flex items-start gap-3 text-[14.5px]">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
          checked={form.linkosSync}
          onChange={(e) => set("linkosSync", e.target.checked)}
          disabled={locked || busy}
          aria-describedby="integration-sync-hint"
        />
        <span>
          상담 내용을 LINKOS 연락처로 전달
          <span id="integration-sync-hint" className="mt-0.5 block text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            상담을 남긴 분의 성함·연락처·문의 내용이 내 LINKOS 연락처로 들어갑니다. 마케팅 동의 여부는
            전달되지 않습니다.
          </span>
        </span>
      </label>

      {/* ── 배지 조회 허용 (05 문서 §3) ────────────────────── */}
      <label className="flex items-start gap-3 text-[14.5px]">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
          checked={form.allowDirectoryLookup}
          onChange={(e) => set("allowDirectoryLookup", e.target.checked)}
          disabled={locked || busy}
          aria-describedby="integration-lookup-hint"
        />
        <span>
          다른 사람이 내 검증 정보를 조회하도록 허용
          <span id="integration-lookup-hint" className="mt-0.5 block text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
            내 이메일을 이미 아는 사람이 LINKOS 에서 내 검증 배지를 볼 수 있습니다. 연락처나 증빙은 보이지
            않습니다.
          </span>
        </span>
      </label>

      {/* 켜 둔 상태에서도 남아 있어야 한다 — 저장 뒤에만 알리면 이미 전달이 시작된 다음이다. */}
      {form.linkosSync ? (
        <p role="status" className="panel p-4 text-[13px] leading-relaxed">
          전달을 켜 두면 <b>이 설정을 켠 뒤에 들어온</b> 상담이 LINKOS 로 전달됩니다. 이미 전달된 건은
          끄더라도 저쪽에서 사라지지 않으니, 필요하면 LINKOS 에서 직접 지우세요.
        </p>
      ) : null}

      <div aria-live="polite" className="empty:hidden">
        {notice ? <p className="text-[13px] font-medium">{notice}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-[var(--caution)]">
          {error}
        </p>
      ) : null}

      <div className="pt-1">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void save()}
          disabled={locked || busy || !dirty}
        >
          {busy ? "저장 중…" : "연동 설정 저장"}
        </button>
      </div>
    </section>
  );
}
