"use client";
// UX-012 Person detail — F-019/F-066 명함 원본, F-067 만남 기록, F-070 태그, F-078/F-109 후속 할 일 (+ 기존 타임라인·메모·병합)
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AiLabel, Avatar, PageHeader } from "@/components/Page";
import { ContactComms } from "@/components/ContactComms";
import { OFFLINE_MESSAGE, api, fmtDate, isQueuedOffline, relTime } from "@/lib/client";

const FIELDS = [
  ["fullName", "이름"],
  ["company", "회사"],
  ["jobTitle", "직책"],
  ["department", "부서"],
  ["email", "이메일"],
  ["phone", "전화"],
  ["address", "주소"],
  ["website", "웹사이트"],
] as const;

type Timeline = {
  contact: any;
  encounters: any[];
  notes: any[];
  cards: any[];
  meetings: any[];
  followups: any[];
  actions: any[];
  linkedProfile: { id: string; slug: string; name: string } | null;
  history: { field: string; old_value: string | null; new_value: string | null; changed_at: string }[];
};

type CardImage = { cardId: string; side: "front" | "back"; objectId: string; scanStatus: string; url: string | null };

const FOLLOWUP_KINDS = [
  ["custom", "일반"],
  ["thank_you", "감사 인사"],
  ["check_in", "안부"],
  ["send_material", "자료 전달"],
  ["meeting_request", "미팅 요청"],
] as const;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** <input type="date"> (local) → ISO datetime. Today keeps the current time; other days use a fixed local hour (no timezone day-shift). */
const dateToIso = (d: string, at: "now" | "end" = "now") => {
  if (!d) return undefined;
  if (at === "now" && d === today()) return new Date().toISOString();
  return new Date(`${d}T${at === "end" ? "18:00" : "12:00"}:00`).toISOString();
};
const sideLabel = (s: "front" | "back") => (s === "front" ? "앞면" : "뒷면");

type SpeechCtor =new () => { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

export function PersonDetail({ id }: { id: string }) {
  const router = useRouter();
  const [t, setT] = useState<Timeline | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [dups, setDups] = useState<any[]>([]);
  const [merge, setMerge] = useState<{ other: any; choices: Record<string, "primary" | "secondary"> } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState<{ subject: string; body: string; provenance: string } | null>(null);
  const [summary, setSummary] = useState<{ summary: string; highlights: string[]; provenance: string } | null>(null);
  const [images, setImages] = useState<CardImage[]>([]);
  const [zoom, setZoom] = useState<CardImage | null>(null);
  const [fu, setFu] = useState({ title: "", due: "", kind: "custom" });
  const [enc, setEnc] = useState({ place: "", note: "", date: today() });
  const [encOpen, setEncOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const recRef = useRef<InstanceType<SpeechCtor> | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<Timeline>(`/contacts/${id}`);
      setT(r);
      setForm(Object.fromEntries(FIELDS.map(([k]) => [k, r.contact[k] ?? ""])));
      const d = await api<{ candidates: any[] }>("/contacts/duplicates", { body: { fullName: r.contact.fullName, company: r.contact.company, email: r.contact.email, phone: r.contact.phone, excludeId: id } });
      setDups(d.candidates);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  // F-019 명함 원본 — owner-only signed URLs (short TTL), loaded separately so the timeline never waits on it
  const loadImages = useCallback(async () => {
    try {
      const r = await api<{ images: CardImage[] }>(`/contacts/${id}/images`);
      setImages(r.images);
    } catch {
      setImages([]);
    }
  }, [id]);
  useEffect(() => {
    load();
    loadImages();
  }, [load, loadImages]);
  // F-080: "음성 메모 남기기" right after an exchange links here with ?voice=1#note — bring the memo box into view.
  // The mic itself needs a user tap (browser rule), so we only focus the box and point at the mic button.
  const loaded = t !== null;
  useEffect(() => {
    if (!loaded || typeof window === "undefined") return;
    const wantsNote = window.location.hash === "#note" || new URLSearchParams(window.location.search).get("voice") === "1";
    if (!wantsNote) return;
    document.getElementById("note")?.scrollIntoView({ block: "center" });
    noteRef.current?.focus({ preventScroll: true });
  }, [loaded]);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  if (error) return <p className="text-[var(--color-ember)]">{error}</p>;
  if (!t) return <div className="surface h-60 animate-pulse" />;
  const c = t.contact;
  const openFollowups = t.followups.filter((f) => f.status === "open");

  const save = async () => {
    try {
      await api(`/contacts/${id}`, { method: "PATCH", body: { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v || null])), fullName: form.fullName, version: c.version } });
      setEdit(false);
      setFlash("저장했어요");
      load();
    } catch (e) {
      setFlash((e as Error).message);
    }
  };

  // F-080 음성 메모: 브라우저 음성 인식(지원 기기)으로 받아쓴 텍스트를 개인 메모로 저장. 오디오는 서버로 전송하지 않음.
  const speechCtor = (): SpeechCtor | null => (typeof window === "undefined" ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null));
  const toggleVoice = () => {
    const Ctor = speechCtor();
    if (!Ctor) {
      setFlash("이 브라우저는 음성 받아쓰기를 지원하지 않아요. 키보드의 음성 입력을 사용하세요.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = true;
    const base = note ? `${note} ` : "";
    rec.onresult = (e: any) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setNote(base + text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const makeDraft = async (kind: "thank_you" | "check_in" | "send_material") => {
    const r = await api<{ result: { subject: string; body: string }; provenance: string }>(`/contacts/${id}/draft`, { body: { kind } });
    setDraft({ ...r.result, provenance: r.provenance });
  };

  const loadSummary = async (profileId: string) => {
    const r = await api<{ result: { summary: string; highlights: string[] }; provenance: string }>(`/profiles/${profileId}/summary`);
    setSummary({ ...r.result, provenance: r.provenance });
  };

  const addNote = async () => {
    if (!note.trim()) return;
    recRef.current?.stop();
    await api(`/contacts/${id}/notes`, { body: { body: note, kind: listening ? "voice" : "text" } });
    setNote("");
    load();
  };

  const doMerge = async () => {
    if (!merge) return;
    await api(`/contacts/${id}/merge`, { body: { secondaryId: merge.other.id, choices: merge.choices } });
    setMerge(null);
    setFlash("병합했어요 · 되돌리기 가능");
    load();
  };

  const undo = async () => {
    await api(`/contacts/${id}/merge/undo`, { body: {} });
    setFlash("병합을 되돌렸어요");
    load();
  };

  const completeFollowup = async (fid: string) => {
    await api(`/followups/${fid}`, { method: "PATCH", body: { status: "done" } });
    load();
  };

  const attempt = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setFlash(ok);
      return true;
    } catch (e) {
      setFlash(isQueuedOffline(e) ? OFFLINE_MESSAGE : (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // F-078/F-109 후속 할 일 직접 추가 — 할 일만 저장, 자동 발송 없음 (CLAUDE.md §2-8)
  const addFollowup = async () => {
    if (!fu.title.trim()) return;
    const ok = await attempt(() => api("/followups", { body: { contactId: id, kind: fu.kind, title: fu.title.trim(), dueAt: dateToIso(fu.due, "end") ?? null } }), "후속 할 일을 추가했어요");
    if (ok) {
      setFu({ title: "", due: "", kind: "custom" });
      load();
    }
  };

  // F-067 만남 기록
  const addEncounter = async () => {
    if (!enc.place.trim() && !enc.note.trim()) return;
    const ok = await attempt(
      () => api(`/contacts/${id}/encounters`, { body: { placeLabel: enc.place.trim() || undefined, note: enc.note.trim() || undefined, occurredAt: dateToIso(enc.date) } }),
      "만남을 기록했어요",
    );
    if (ok) {
      setEnc({ place: "", note: "", date: today() });
      setEncOpen(false);
      load();
    }
  };

  // F-070 태그 — PATCH /contacts/{id} {tags} replaces the whole set
  const tags: string[] = c.tags ?? [];
  const saveTags = async (next: string[]) => {
    const ok = await attempt(() => api(`/contacts/${id}`, { method: "PATCH", body: { tags: next } }), "태그를 저장했어요");
    if (ok) load();
  };
  const addTag = () => {
    const v = tagDraft.trim().replace(/^#+/, "").trim();
    if (!v) return;
    setTagDraft("");
    if (tags.includes(v)) return;
    if (tags.length >= 20) {
      setFlash("태그는 20개까지 붙일 수 있어요");
      return;
    }
    saveTags([...tags, v]);
  };

  // F-019/F-066 명함 원본 삭제 (면별)
  const deleteImage = async (img: CardImage) => {
    if (!confirm(`명함 ${sideLabel(img.side)} 원본 이미지를 삭제할까요? 되돌릴 수 없어요.`)) return;
    const ok = await attempt(() => api(`/capture/cards/${img.cardId}/images/${img.side}`, { method: "DELETE" }), "원본 이미지를 삭제했어요");
    if (ok) {
      setZoom(null);
      loadImages();
    }
  };

  const remove = async () => {
    if (!confirm(`${c.fullName}님을 인맥에서 삭제할까요?`)) return;
    await api(`/contacts/${id}`, { method: "DELETE" });
    router.push("/app/people");
  };

  const events: { at: string; icon: IconName; title: string; body?: string; tag?: string }[] = [
    ...t.encounters.map((e) => ({ at: e.occurred_at, icon: "exchange" as IconName, title: e.source === "exchange" ? "명함 교환" : e.source === "scan" ? "명함 스캔" : "만남", body: [e.place_label, e.event_name, e.note].filter(Boolean).join(" · ") })),
    ...t.notes.map((n) => ({ at: n.created_at, icon: "edit" as IconName, title: "개인 메모", body: n.body, tag: "나만 보기" })),
    ...t.meetings.map((m) => ({ at: m.started_at ?? m.created_at, icon: "calendar" as IconName, title: m.title, body: m.purpose })),
    ...(t.history ?? []).map((h) => ({ at: h.changed_at, icon: "edit" as IconName, title: `${FIELDS.find(([k]) => k === h.field)?.[1] ?? h.field} 변경`, body: `${h.old_value || "—"} → ${h.new_value || "—"}` })),
    ...t.cards.map((b) => ({ at: b.captured_at, icon: "camera" as IconName, title: "명함 원본", body: b.source === "guest_exchange" ? "상대가 촬영해 보낸 명함" : "OCR 스캔" })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div>
      <PageHeader back="/app/people" eyebrow={c.source === "exchange" ? "교환으로 연결됨" : c.source === "scan" ? "스캔으로 추가" : "Contact"} title={c.fullName} />
      {flash && (
        <p className="mb-4 flex items-center justify-between rounded-2xl bg-[var(--color-signal)]/25 px-4 py-2.5 text-[14px] font-medium" role="status">
          {flash}
          {flash.startsWith("병합했어요") && <button onClick={undo} className="font-semibold underline">되돌리기</button>}
        </p>
      )}

      <section className="surface p-5 animate-rise">
        <div className="flex items-start gap-4">
          <Avatar name={c.fullName} size={56} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-[var(--fg-mute)]">{[c.company, c.department, c.jobTitle].filter(Boolean).join(" · ") || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.email && <a href={`mailto:${c.email}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="mail" size={16} />메일</a>}
              {c.phone && <a href={`tel:${c.phone}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="phone" size={16} />전화</a>}
              <a href={`/api/v1/contacts/${id}/vcard`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="download" size={16} />vCard</a>
              {t.linkedProfile && <Link href={`/p/${t.linkedProfile.slug}`} className="btn btn-signal !min-h-10 !px-3 text-[14px]"><Icon name="eye" size={16} />Living Card</Link>}
            </div>
          </div>
          <button onClick={() => setEdit(!edit)} className="grid size-10 place-items-center rounded-full border border-[var(--line)]" aria-label="정보 편집">
            <Icon name="edit" size={17} />
          </button>
        </div>

        {edit ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {FIELDS.map(([k, label]) => (
              <label key={k}>
                <span className="label">{label}</span>
                <input className="field" value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </label>
            ))}
            <div className="flex gap-2 sm:col-span-2">
              <button onClick={save} className="btn btn-signal">저장</button>
              <button onClick={() => setEdit(false)} className="btn btn-ghost">취소</button>
              <button onClick={remove} className="btn ml-auto text-[var(--color-ember)]">삭제</button>
            </div>
          </div>
        ) : (
          <dl className="mt-5 grid gap-x-6 gap-y-3 text-[14.5px] sm:grid-cols-2">
            {FIELDS.slice(4).map(([k, label]) =>
              c[k] ? (
                <div key={k}>
                  <dt className="text-[11.5px] uppercase tracking-[0.12em] text-[var(--fg-mute)]">
                    {label}
                    {c.provenance?.[k] && <span className="ml-1.5 normal-case tracking-normal">· {c.provenance[k].source === "ocr" ? `OCR ${Math.round((c.provenance[k].confidence ?? 0) * 100)}%` : c.provenance[k].source === "user" ? "직접 입력" : c.provenance[k].source}</span>}
                  </dt>
                  <dd className="mt-0.5 break-words font-medium">{c[k]}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
      </section>

      <section className="mt-4" aria-label="태그">
        <ul className="flex flex-wrap items-center gap-2" data-testid="contact-tags">
          {tags.map((tg) => (
            <li key={tg} className="chip !pr-1">
              #{tg}
              <button type="button" disabled={busy} onClick={() => saveTags(tags.filter((x) => x !== tg))} className="grid size-6 place-items-center rounded-full hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]" aria-label={`${tg} 태그 삭제`}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <input
              className="field !min-h-9 !w-36 !py-1.5 text-[14px]"
              placeholder="#태그 추가"
              aria-label="태그 추가"
              maxLength={40}
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addTag();
                }
              }}
            />
            <button type="button" onClick={addTag} disabled={busy || !tagDraft.trim()} className="grid size-9 place-items-center rounded-full border border-[var(--line)]" aria-label="태그 저장">
              <Icon name="plus" size={15} />
            </button>
          </li>
        </ul>
      </section>

      {images.length > 0 && (
        <section className="surface mt-4 p-4" aria-label="명함 원본" data-testid="card-images">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold">
            <Icon name="camera" size={17} />명함 원본 <span className="text-[12.5px] font-normal text-[var(--fg-mute)]">· 나만 볼 수 있어요</span>
          </p>
          <ul className="mt-3 flex flex-wrap gap-3">
            {images.map((img) => (
              <li key={img.objectId} className="w-32">
                {img.url && img.scanStatus !== "quarantined" ? (
                  <button type="button" onClick={() => setZoom(img)} className="block w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-sunk)]" aria-label={`명함 ${sideLabel(img.side)} 크게 보기`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed private URL; must not go through the image optimizer cache */}
                    <img src={img.url} alt={`명함 ${sideLabel(img.side)}`} loading="lazy" decoding="async" width={128} height={80} className="aspect-[1.6] w-full object-cover" />
                  </button>
                ) : (
                  <div className="grid aspect-[1.6] w-full place-items-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--bg-sunk)] px-2 text-center text-[11.5px] text-[var(--fg-mute)]">
                    {img.scanStatus === "quarantined" ? "보안 검사에서 차단된 파일" : "보안 검사 중이에요"}
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between text-[12px] text-[var(--fg-mute)]">
                  <span>
                    {sideLabel(img.side)}
                    {img.scanStatus === "unscanned" && " · 검사 대기"}
                  </span>
                  <button type="button" onClick={() => deleteImage(img)} disabled={busy} className="grid size-8 place-items-center rounded-full hover:text-[var(--color-ember)]" aria-label={`명함 ${sideLabel(img.side)} 원본 삭제`}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {zoom?.url && (
        <div role="dialog" aria-modal="true" aria-label="명함 원본 크게 보기" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[color-mix(in_srgb,var(--color-ink)_82%,transparent)] p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.url} alt={`명함 ${sideLabel(zoom.side)} 원본`} className="max-h-[70dvh] max-w-full rounded-2xl object-contain" onClick={(e) => e.stopPropagation()} />
          <div className="flex gap-2 pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
            <button type="button" autoFocus onClick={() => setZoom(null)} className="btn btn-ghost !bg-[var(--bg)]"><Icon name="x" size={16} />닫기</button>
            <button type="button" onClick={() => deleteImage(zoom)} className="btn !bg-[var(--bg)] text-[var(--color-ember)]"><Icon name="trash" size={16} />삭제</button>
          </div>
        </div>
      )}

      {dups.length > 0 && !merge && (
        <section className="mt-4 rounded-[22px] border border-[var(--color-ember)]/40 p-4">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold"><Icon name="merge" size={18} />중복일 수 있는 연락처</p>
          {dups.map((d) => (
            <div key={d.contact.id} className="mt-3 flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[14px]">
                <b>{d.contact.fullName}</b> · {d.contact.company ?? "—"} <span className="text-[var(--fg-mute)]">({d.reasons.join(", ")} · {Math.round(d.score * 100)}%)</span>
              </span>
              <button className="btn btn-ghost !min-h-10" onClick={() => setMerge({ other: d.contact, choices: {} })}>비교·병합</button>
            </div>
          ))}
        </section>
      )}

      {merge && (
        <section className="surface mt-4 p-4" aria-label="병합 검토">
          <h3 className="text-[16px] font-semibold">필드별로 남길 값을 고르세요</h3>
          <div className="mt-3 space-y-2">
            {FIELDS.map(([k, label]) => {
              const a = c[k] ?? "";
              const b = merge.other[k] ?? "";
              if (!a && !b) return null;
              const choice = merge.choices[k] ?? (a ? "primary" : "secondary");
              return (
                <div key={k} className="grid grid-cols-[70px_1fr_1fr] items-center gap-2 text-[14px]">
                  <span className="text-[var(--fg-mute)]">{label}</span>
                  {(["primary", "secondary"] as const).map((side) => (
                    <button key={side} disabled={a === b} onClick={() => setMerge({ ...merge, choices: { ...merge.choices, [k]: side } })} className={`truncate rounded-xl border px-3 py-2 text-left ${choice === side ? "border-[var(--fg)] bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] font-semibold" : "border-[var(--line)]"}`}>
                      {(side === "primary" ? a : b) || "—"}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={doMerge} className="btn btn-signal">병합</button>
            <button onClick={() => setMerge(null)} className="btn btn-ghost">취소</button>
          </div>
        </section>
      )}

      {t.linkedProfile && (
        <section className="surface mt-4 p-4">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{t.linkedProfile.name}님의 Living Card 요약</p>
            {!summary && <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => loadSummary(t.linkedProfile!.id).catch((e) => setFlash((e as Error).message))}>요약 보기</button>}
          </div>
          {summary && (
            <div className="mt-2 space-y-2 text-[14.5px]">
              <AiLabel>{summary.provenance === "ai_inferred" ? "AI 요약" : "카드 정보 요약"}</AiLabel>
              <p>{summary.summary}</p>
              <ul className="list-disc pl-5 text-[var(--fg-mute)]">{summary.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <section id="followups" className="mt-6" aria-label="후속 할 일" data-testid="followups">
        <h2 className="mb-2 text-[17px] font-semibold">후속 할 일 <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 자동 발송되지 않아요</span></h2>
        {openFollowups.length === 0 ? (
          <p className="mb-2 text-[14px] text-[var(--fg-mute)]">열린 후속 할 일이 없어요. 아래에서 직접 추가할 수 있어요.</p>
        ) : (
          <ul className="space-y-2">
            {openFollowups.map((f) => (
              <li key={f.id} className="surface p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{f.title} {f.source === "ai_suggested" && <AiLabel>AI 제안</AiLabel>}</p>
                    {f.body_draft && <p className="mt-1.5 whitespace-pre-wrap text-[14px] text-[var(--fg-mute)]">{f.body_draft}</p>}
                    <p className="mt-1 text-[12.5px] text-[var(--fg-mute)]">{[FOLLOWUP_KINDS.find(([k]) => k === f.kind)?.[1], f.due_at ? `기한 ${fmtDate(f.due_at)}` : "기한 없음"].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    {c.email && f.body_draft && <a className="btn btn-ghost !min-h-9 !px-3 text-[13px]" href={`mailto:${c.email}?subject=${encodeURIComponent(f.title)}&body=${encodeURIComponent(f.body_draft)}`}>메일 쓰기</a>}
                    <button onClick={() => completeFollowup(f.id)} className="btn btn-signal !min-h-9 !px-3 text-[13px]">완료</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="surface mt-2 grid gap-2 p-4 sm:grid-cols-[1fr_auto_auto]"
          aria-label="후속 할 일 추가"
          onSubmit={(e) => {
            e.preventDefault();
            addFollowup();
          }}
        >
          <input className="field sm:col-span-3" placeholder="할 일 (예: 제안서 보내기)" aria-label="후속 할 일 제목" maxLength={200} value={fu.title} onChange={(e) => setFu({ ...fu, title: e.target.value })} />
          <input type="date" className="field" aria-label="기한 (선택)" value={fu.due} min={today()} onChange={(e) => setFu({ ...fu, due: e.target.value })} />
          <select className="field" aria-label="종류" value={fu.kind} onChange={(e) => setFu({ ...fu, kind: e.target.value })}>
            {FOLLOWUP_KINDS.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          <button type="submit" disabled={busy || !fu.title.trim()} className="btn btn-signal">
            <Icon name="plus" size={16} />후속 할 일 추가
          </button>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-[17px] font-semibold">후속 메일 초안 <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 자동 발송되지 않아요</span></h2>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("thank_you")}>감사 인사</button>
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("check_in")}>안부</button>
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("send_material")}>자료 전달</button>
        </div>
        {draft && (
          <div className="surface mt-3 space-y-2 p-4" data-testid="draft">
            <AiLabel>{draft.provenance === "ai_inferred" ? "AI 초안 · 확인 후 사용" : "템플릿 초안"}</AiLabel>
            <input className="field" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} aria-label="제목" />
            <textarea className="field min-h-32" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="본문" />
            {c.email && <a className="btn btn-signal" href={`mailto:${c.email}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}>메일 앱에서 열기</a>}
          </div>
        )}
      </section>

      <ContactComms contactId={id} email={c.email} phone={c.phone} />

      <section className="mt-6 scroll-mt-24" id="note">
        <h2 className="mb-2 text-[17px] font-semibold">메모 <span className="text-[13px] font-normal text-[var(--fg-mute)]">· 상대에게 절대 공개되지 않아요</span></h2>
        <div className="flex gap-2">
          <input ref={noteRef} aria-label="개인 메모" className="field" placeholder="무슨 이야기를 나눴나요?" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
          <button onClick={toggleVoice} className={`btn shrink-0 ${listening ? "btn-signal" : "btn-ghost"}`} aria-label={listening ? "받아쓰기 중지" : "음성 메모"} aria-pressed={listening}><Icon name="mic" size={18} /></button>
          <button onClick={addNote} className="btn btn-ink shrink-0" aria-label="메모 추가"><Icon name="plus" size={18} /></button>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold">관계 타임라인</h2>
          <button type="button" onClick={() => setEncOpen(!encOpen)} aria-expanded={encOpen} className="btn btn-ghost !min-h-10 !px-3 text-[14px]">
            <Icon name="plus" size={16} />만남 기록
          </button>
        </div>
        {encOpen && (
          <form
            className="surface mb-5 grid gap-2 p-4 sm:grid-cols-2"
            aria-label="만남 기록"
            onSubmit={(e) => {
              e.preventDefault();
              addEncounter();
            }}
          >
            <input className="field" placeholder="장소 (예: 코엑스 라운지)" aria-label="만난 장소" maxLength={200} value={enc.place} onChange={(e) => setEnc({ ...enc, place: e.target.value })} />
            <input type="date" className="field" aria-label="만난 날짜" max={today()} value={enc.date} onChange={(e) => setEnc({ ...enc, date: e.target.value })} />
            <textarea className="field min-h-20 sm:col-span-2" placeholder="어떤 만남이었나요? (나만 보기)" aria-label="만남 메모" maxLength={2000} value={enc.note} onChange={(e) => setEnc({ ...enc, note: e.target.value })} />
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" disabled={busy || (!enc.place.trim() && !enc.note.trim())} className="btn btn-signal">기록하기</button>
              <button type="button" onClick={() => setEncOpen(false)} className="btn btn-ghost">취소</button>
            </div>
          </form>
        )}
        <ol className="relative space-y-5 border-l border-[var(--line-strong)] pl-6">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[37px] grid size-7 place-items-center rounded-full border border-[var(--line-strong)] bg-[var(--bg)]">
                <Icon name={e.icon} size={14} />
              </span>
              <p className="text-[12px] text-[var(--fg-mute)]">{fmtDate(e.at, { year: "numeric", month: "short", day: "numeric" })} · {relTime(e.at)}</p>
              <p className="font-semibold">{e.title} {e.tag && <span className="chip ml-1 !py-0.5 text-[11px]"><Icon name="lock" size={11} />{e.tag}</span>}</p>
              {e.body && <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] text-[var(--fg-mute)]">{e.body}</p>}
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href={`/app/meetings/new?contact=${id}`} className="btn btn-ghost"><Icon name="calendar" size={17} />미팅 카드 만들기</Link>
        <Link href={`/app/intros?a=${id}`} className="btn btn-ghost"><Icon name="room" size={17} />소개하기</Link>
      </div>
    </div>
  );
}
