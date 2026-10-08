"use client";
// UX-012 Person detail — F-019/F-066 명함 원본, F-067 만남 기록, F-070 태그, F-078/F-109 후속 할 일 (+ 기존 타임라인·메모·병합)
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AiLabel, Avatar, PageHeader } from "@/components/Page";
import { ContactComms } from "@/components/ContactComms";
import { useI18n } from "@/components/I18n";
import { OFFLINE_MESSAGE, api, fmtDate, isQueuedOffline, relTime } from "@/lib/client";
import { intlLocale, tf } from "@/lib/i18n";
import { type MemoTodo, extractTodos, formatElapsed } from "@/lib/voiceMemo";

// UX-012 Person Detail · F-177 ko/en · F-080 voice memo + on-device structuring
const FIELD_KEYS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website"] as const;

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

const FOLLOWUP_KINDS = ["custom", "thank_you", "check_in", "send_material", "meeting_request"] as const;

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
const sideLabel = (s: "front" | "back", P: { front: string; back: string }) => (s === "front" ? P.front : P.back);

type SpeechCtor =new () => { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

/** yyyy-mm-dd in local time for <input type="date"> */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromDateInput(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0).toISOString() : null;
}

type Suggestion = MemoTodo & { state: "open" | "busy" | "created" | "dismissed" };

/** F-080: to-dos pulled from the memo by the on-device extractor — each becomes a follow-up only after the user confirms it. */
function MemoSuggestions({ contactId, items, onChange, onCreated }: { contactId: string; items: Suggestion[]; onChange: (s: Suggestion[]) => void; onCreated: () => void }) {
  const { locale, m } = useI18n();
  const P = m.person;
  const [err, setErr] = useState<string | null>(null);
  const patch = (id: string, v: Partial<Suggestion>) => onChange(items.map((x) => (x.id === id ? { ...x, ...v } : x)));
  const create = async (s: Suggestion) => {
    setErr(null);
    patch(s.id, { state: "busy" });
    try {
      await api("/followups", { body: { contactId, kind: s.kind, title: s.title.trim(), dueAt: s.dueAt } });
      onChange(items.map((x) => (x.id === s.id ? { ...x, state: "created" } : x)));
      onCreated();
    } catch (e) {
      onChange(items.map((x) => (x.id === s.id ? { ...x, state: "open" } : x)));
      setErr((e as Error).message);
    }
  };
  const visible = items.filter((x) => x.state !== "dismissed");
  return (
    <div className="surface mt-3 space-y-3 p-4" data-testid="memo-suggestions" aria-label={P.structureTitle} role="region">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[15px] font-semibold">{P.structureTitle}</p>
        <AiLabel>{P.structureLabel}</AiLabel>
      </div>
      <p className="text-[12.5px] text-[var(--fg-mute)]">{P.structureHint}</p>
      {visible.length === 0 ? (
        <p className="text-[14px] text-[var(--fg-mute)]">{P.structureNone}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((s) => (
            <li key={s.id} className="rounded-2xl border border-[var(--line)] p-3" data-testid="memo-suggestion">
              {s.state === "created" ? (
                <p className="flex items-center gap-2 text-[14px] font-medium"><Icon name="check" size={16} />{s.title} · <span className="text-[var(--fg-mute)]">{P.created}</span></p>
              ) : (
                <div className="space-y-2">
                  <input className="field !min-h-10 !py-2 !text-[14.5px]" value={s.title} maxLength={200} aria-label={P.subject} onChange={(e) => patch(s.id, { title: e.target.value })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-[var(--fg-mute)]">
                      {P.dueLabel}
                      <input type="date" className="field !min-h-9 !w-auto !py-1 !text-[13px]" value={toDateInput(s.dueAt)} onChange={(e) => patch(s.id, { dueAt: fromDateInput(e.target.value) })} />
                    </label>
                    {s.dueText && <span className="chip !py-0.5 text-[11.5px]">“{s.dueText}”</span>}
                    {!s.dueAt && <span className="text-[12px] text-[var(--fg-mute)]">{P.noDueLabel}</span>}
                    <span className="ml-auto flex gap-2">
                      <button type="button" className="btn btn-ghost !min-h-9 !px-3 text-[13px]" onClick={() => patch(s.id, { state: "dismissed" })}>{P.dismiss}</button>
                      <button type="button" className="btn btn-signal !min-h-9 !px-3 text-[13px]" disabled={s.state === "busy" || !s.title.trim()} onClick={() => create(s)} data-testid="memo-confirm">
                        {P.confirmCreate}
                      </button>
                    </span>
                  </div>
                  {s.dueAt && <p className="text-[12px] text-[var(--fg-mute)]">{fmtDate(s.dueAt, { month: "short", day: "numeric", weekday: "short" }, intlLocale(locale))}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p role="alert" className="text-[13px] text-[var(--color-ember)]">{err}</p>}
    </div>
  );
}

export function PersonDetail({ id }: { id: string }) {
  const router = useRouter();
  const { locale, m } = useI18n();
  const P = m.person;
  const lang = intlLocale(locale);
  const FIELDS = FIELD_KEYS.map((k) => [k, P.fields[k] ?? k] as const);
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
  // F-080: dictation timer + "정리하기" suggestions
  const [dictStart, setDictStart] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [dictated, setDictated] = useState(false);
  const [todos, setTodos] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [listening]);
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
      setForm(Object.fromEntries(FIELD_KEYS.map((k) => [k, r.contact[k] ?? ""])));
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
      setFlash(P.saved);
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
      setFlash(P.noSpeech);
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    const base = note ? `${note} ` : "";
    rec.onresult = (e: any) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setNote(base + text);
    };
    const stop = () => {
      setListening(false);
      setDictStart(null);
    };
    rec.onend = stop;
    rec.onerror = stop;
    recRef.current = rec;
    setListening(true);
    setDictated(true);
    setDictStart(Date.now());
    setTick(Date.now());
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
    await api(`/contacts/${id}/notes`, { body: { body: note, kind: listening || dictated ? "voice" : "text" } });
    setNote("");
    setDictated(false);
    load();
  };

  // F-080: deterministic on-device extraction — nothing is created until each item is confirmed
  const structure = () => {
    recRef.current?.stop();
    setTodos(extractTodos(note).map((x) => ({ ...x, state: "open" as const })));
  };

  const doMerge = async () => {
    if (!merge) return;
    await api(`/contacts/${id}/merge`, { body: { secondaryId: merge.other.id, choices: merge.choices } });
    setMerge(null);
    setFlash(P.merged);
    load();
  };

  const undo = async () => {
    await api(`/contacts/${id}/merge/undo`, { body: {} });
    setFlash(P.unmerged);
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
    const ok = await attempt(() => api("/followups", { body: { contactId: id, kind: fu.kind, title: fu.title.trim(), dueAt: dateToIso(fu.due, "end") ?? null } }), P.fuAdded);
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
      P.encAdded,
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
    const ok = await attempt(() => api(`/contacts/${id}`, { method: "PATCH", body: { tags: next } }), P.tagsSaved);
    if (ok) load();
  };
  const addTag = () => {
    const v = tagDraft.trim().replace(/^#+/, "").trim();
    if (!v) return;
    setTagDraft("");
    if (tags.includes(v)) return;
    if (tags.length >= 20) {
      setFlash(P.tagsMax);
      return;
    }
    saveTags([...tags, v]);
  };

  // F-019/F-066 명함 원본 삭제 (면별)
  const deleteImage = async (img: CardImage) => {
    if (!confirm(tf(P.imgConfirmDelete, { side: sideLabel(img.side, P) }))) return;
    const ok = await attempt(() => api(`/capture/cards/${img.cardId}/images/${img.side}`, { method: "DELETE" }), P.imgDeleted);
    if (ok) {
      setZoom(null);
      loadImages();
    }
  };

  const remove = async () => {
    if (!confirm(tf(P.confirmDelete, { name: c.fullName }))) return;
    await api(`/contacts/${id}`, { method: "DELETE" });
    router.push("/app/people");
  };

  const events: { at: string; icon: IconName; title: string; body?: string; tag?: string }[] = [
    ...t.encounters.map((e) => ({ at: e.occurred_at, icon: "exchange" as IconName, title: e.source === "exchange" ? P.evExchange : e.source === "scan" ? P.evScan : P.evMeet, body: [e.place_label, e.event_name, e.note].filter(Boolean).join(" · ") })),
    ...t.notes.map((n) => ({ at: n.created_at, icon: "edit" as IconName, title: P.evNote, body: n.body, tag: P.evPrivate })),
    ...t.meetings.map((m) => ({ at: m.started_at ?? m.created_at, icon: "calendar" as IconName, title: m.title, body: m.purpose })),
    ...(t.history ?? []).map((h) => ({ at: h.changed_at, icon: "edit" as IconName, title: tf(P.evChanged, { field: P.fields[h.field] ?? h.field }), body: `${h.old_value || "—"} → ${h.new_value || "—"}` })),
    ...t.cards.map((b) => ({ at: b.captured_at, icon: "camera" as IconName, title: P.evCard, body: b.source === "guest_exchange" ? P.evCardGuest : P.evCardOcr })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div>
      <PageHeader back="/app/people" eyebrow={c.source === "exchange" ? P.viaExchange : c.source === "scan" ? P.viaScan : "Contact"} title={c.fullName} />
      {flash && (
        <p className="mb-4 flex items-center justify-between rounded-2xl bg-[var(--color-signal)]/25 px-4 py-2.5 text-[14px] font-medium" role="status">
          {flash}
          {flash === P.merged && <button onClick={undo} className="font-semibold underline">{P.undo}</button>}
        </p>
      )}

      <section className="surface p-5 animate-rise">
        <div className="flex items-start gap-4">
          <Avatar name={c.fullName} size={56} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-[var(--fg-mute)]">{[c.company, c.department, c.jobTitle].filter(Boolean).join(" · ") || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.email && <a href={`mailto:${c.email}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="mail" size={16} />{P.mail}</a>}
              {c.phone && <a href={`tel:${c.phone}`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="phone" size={16} />{P.call}</a>}
              <a href={`/api/v1/contacts/${id}/vcard`} className="btn btn-ghost !min-h-10 !px-3 text-[14px]"><Icon name="download" size={16} />vCard</a>
              {t.linkedProfile && <Link href={`/p/${t.linkedProfile.slug}`} className="btn btn-signal !min-h-10 !px-3 text-[14px]"><Icon name="eye" size={16} />Living Card</Link>}
            </div>
          </div>
          <button onClick={() => setEdit(!edit)} className="grid size-10 place-items-center rounded-full border border-[var(--line)]" aria-label={P.editInfo}>
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
              <button onClick={save} className="btn btn-signal">{m.common.save}</button>
              <button onClick={() => setEdit(false)} className="btn btn-ghost">{m.common.cancel}</button>
              <button onClick={remove} className="btn ml-auto text-[var(--color-ember)]">{m.common.delete}</button>
            </div>
          </div>
        ) : (
          <dl className="mt-5 grid gap-x-6 gap-y-3 text-[14.5px] sm:grid-cols-2">
            {FIELDS.slice(4).map(([k, label]) =>
              c[k] ? (
                <div key={k}>
                  <dt className="text-[11.5px] uppercase tracking-[0.12em] text-[var(--fg-mute)]">
                    {label}
                    {c.provenance?.[k] && <span className="ml-1.5 normal-case tracking-normal">· {c.provenance[k].source === "ocr" ? `OCR ${Math.round((c.provenance[k].confidence ?? 0) * 100)}%` : c.provenance[k].source === "user" ? P.userEntered : c.provenance[k].source}</span>}
                  </dt>
                  <dd className="mt-0.5 break-words font-medium">{c[k]}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
      </section>

      <section className="mt-4" aria-label={P.tags}>
        <ul className="flex flex-wrap items-center gap-2" data-testid="contact-tags">
          {tags.map((tg) => (
            <li key={tg} className="chip !pr-1">
              #{tg}
              <button type="button" disabled={busy} onClick={() => saveTags(tags.filter((x) => x !== tg))} className="grid size-6 place-items-center rounded-full hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]" aria-label={tf(P.tagDelete, { tag: tg })}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <input
              className="field !min-h-9 !w-36 !py-1.5 text-[14px]"
              placeholder={P.tagAddPh}
              aria-label={P.tagAdd}
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
            <button type="button" onClick={addTag} disabled={busy || !tagDraft.trim()} className="grid size-9 place-items-center rounded-full border border-[var(--line)]" aria-label={P.tagSave}>
              <Icon name="plus" size={15} />
            </button>
          </li>
        </ul>
      </section>

      {images.length > 0 && (
        <section className="surface mt-4 p-4" aria-label={P.evCard} data-testid="card-images">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold">
            <Icon name="camera" size={17} />{P.evCard} <span className="text-[12.5px] font-normal text-[var(--fg-mute)]">{P.onlyMe}</span>
          </p>
          <ul className="mt-3 flex flex-wrap gap-3">
            {images.map((img) => (
              <li key={img.objectId} className="w-32">
                {img.url && img.scanStatus !== "quarantined" ? (
                  <button type="button" onClick={() => setZoom(img)} className="block w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-sunk)]" aria-label={tf(P.imgZoom, { side: sideLabel(img.side, P) })}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed private URL; must not go through the image optimizer cache */}
                    <img src={img.url} alt={tf(P.imgAlt, { side: sideLabel(img.side, P) })} loading="lazy" decoding="async" width={128} height={80} className="aspect-[1.6] w-full object-cover" />
                  </button>
                ) : (
                  <div className="grid aspect-[1.6] w-full place-items-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--bg-sunk)] px-2 text-center text-[11.5px] text-[var(--fg-mute)]">
                    {img.scanStatus === "quarantined" ? P.imgBlocked : P.imgScanning}
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between text-[12px] text-[var(--fg-mute)]">
                  <span>
                    {sideLabel(img.side, P)}
                    {img.scanStatus === "unscanned" && P.imgPending}
                  </span>
                  <button type="button" onClick={() => deleteImage(img)} disabled={busy} className="grid size-8 place-items-center rounded-full hover:text-[var(--color-ember)]" aria-label={tf(P.imgDelete, { side: sideLabel(img.side, P) })}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {zoom?.url && (
        <div role="dialog" aria-modal="true" aria-label={P.imgZoomDialog} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[color-mix(in_srgb,var(--color-ink)_82%,transparent)] p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.url} alt={tf(P.imgAlt, { side: sideLabel(zoom.side, P) })} className="max-h-[70dvh] max-w-full rounded-2xl object-contain" onClick={(e) => e.stopPropagation()} />
          <div className="flex gap-2 pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
            <button type="button" autoFocus onClick={() => setZoom(null)} className="btn btn-ghost !bg-[var(--bg)]"><Icon name="x" size={16} />{m.common.close}</button>
            <button type="button" onClick={() => deleteImage(zoom)} className="btn !bg-[var(--bg)] text-[var(--color-ember)]"><Icon name="trash" size={16} />{m.common.delete}</button>
          </div>
        </div>
      )}

      {dups.length > 0 && !merge && (
        <section className="mt-4 rounded-[22px] border border-[var(--color-ember)]/40 p-4">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold"><Icon name="merge" size={18} />{P.dupTitle}</p>
          {dups.map((d) => (
            <div key={d.contact.id} className="mt-3 flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[14px]">
                <b>{d.contact.fullName}</b> · {d.contact.company ?? "—"} <span className="text-[var(--fg-mute)]">({d.reasons.join(", ")} · {Math.round(d.score * 100)}%)</span>
              </span>
              <button className="btn btn-ghost !min-h-10" onClick={() => setMerge({ other: d.contact, choices: {} })}>{P.compareMerge}</button>
            </div>
          ))}
        </section>
      )}

      {merge && (
        <section className="surface mt-4 p-4" aria-label={P.mergeReview}>
          <h3 className="text-[16px] font-semibold">{P.mergePick}</h3>
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
            <button onClick={doMerge} className="btn btn-signal">{P.merge}</button>
            <button onClick={() => setMerge(null)} className="btn btn-ghost">{m.common.cancel}</button>
          </div>
        </section>
      )}

      {t.linkedProfile && (
        <section className="surface mt-4 p-4">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{tf(P.cardSummary, { name: t.linkedProfile.name })}</p>
            {!summary && <button className="btn btn-ghost !min-h-9 text-[13px]" onClick={() => loadSummary(t.linkedProfile!.id).catch((e) => setFlash((e as Error).message))}>{P.showSummary}</button>}
          </div>
          {summary && (
            <div className="mt-2 space-y-2 text-[14.5px]">
              <AiLabel>{summary.provenance === "ai_inferred" ? P.aiSummary : P.cardSummaryLabel}</AiLabel>
              <p>{summary.summary}</p>
              <ul className="list-disc pl-5 text-[var(--fg-mute)]">{summary.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <section id="followups" className="mt-6" aria-label={P.followupsTitle} data-testid="followups">
        <h2 className="mb-2 text-[17px] font-semibold">{P.followupsTitle} <span className="text-[13px] font-normal text-[var(--fg-mute)]">{P.draftsNote}</span></h2>
        {openFollowups.length === 0 ? (
          <p className="mb-2 text-[14px] text-[var(--fg-mute)]">{P.noFollowups}</p>
        ) : (
          <ul className="space-y-2">
            {openFollowups.map((f) => (
              <li key={f.id} className="surface p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{f.title} {f.source === "ai_suggested" && <AiLabel>{P.aiSuggested}</AiLabel>}</p>
                    {f.body_draft && <p className="mt-1.5 whitespace-pre-wrap text-[14px] text-[var(--fg-mute)]">{f.body_draft}</p>}
                    <p className="mt-1 text-[12.5px] text-[var(--fg-mute)]">{[P.kinds[f.kind], f.due_at ? tf(P.due, { date: fmtDate(f.due_at, undefined, lang) }) : P.noDueLabel].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    {c.email && f.body_draft && <a className="btn btn-ghost !min-h-9 !px-3 text-[13px]" href={`mailto:${c.email}?subject=${encodeURIComponent(f.title)}&body=${encodeURIComponent(f.body_draft)}`}>{P.writeMail}</a>}
                    <button onClick={() => completeFollowup(f.id)} className="btn btn-signal !min-h-9 !px-3 text-[13px]">{P.done}</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="surface mt-2 grid gap-2 p-4 sm:grid-cols-[1fr_auto_auto]"
          aria-label={P.fuAdd}
          onSubmit={(e) => {
            e.preventDefault();
            addFollowup();
          }}
        >
          <input className="field sm:col-span-3" placeholder={P.fuTitlePh} aria-label={P.fuTitle} maxLength={200} value={fu.title} onChange={(e) => setFu({ ...fu, title: e.target.value })} />
          <input type="date" className="field" aria-label={P.fuDue} value={fu.due} min={today()} onChange={(e) => setFu({ ...fu, due: e.target.value })} />
          <select className="field" aria-label={P.fuKind} value={fu.kind} onChange={(e) => setFu({ ...fu, kind: e.target.value })}>
            {FOLLOWUP_KINDS.map((k) => (
              <option key={k} value={k}>{P.kinds[k]}</option>
            ))}
          </select>
          <button type="submit" disabled={busy || !fu.title.trim()} className="btn btn-signal">
            <Icon name="plus" size={16} />{P.fuAdd}
          </button>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-[17px] font-semibold">{P.draftsTitle} <span className="text-[13px] font-normal text-[var(--fg-mute)]">{P.draftsNote}</span></h2>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("thank_you")}>{P.thankYou}</button>
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("check_in")}>{P.checkIn}</button>
          <button className="btn btn-ghost !min-h-10 text-[14px]" onClick={() => makeDraft("send_material")}>{P.sendMaterial}</button>
        </div>
        {draft && (
          <div className="surface mt-3 space-y-2 p-4" data-testid="draft">
            <AiLabel>{draft.provenance === "ai_inferred" ? P.aiDraft : P.templateDraft}</AiLabel>
            <input className="field" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} aria-label={P.subject} />
            <textarea className="field min-h-32" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label={P.body} />
            {c.email && <a className="btn btn-signal" href={`mailto:${c.email}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}>{P.openMailApp}</a>}
          </div>
        )}
      </section>

      <ContactComms contactId={id} email={c.email} phone={c.phone} />

      <section className="mt-6 scroll-mt-24" id="note">
        <h2 className="mb-2 text-[17px] font-semibold">{P.noteTitle} <span className="text-[13px] font-normal text-[var(--fg-mute)]">{P.noteNote}</span></h2>
        <div className="flex gap-2">
          <input ref={noteRef} aria-label={P.evNote} className="field" placeholder={P.notePh} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
          <button onClick={toggleVoice} className={`btn shrink-0 ${listening ? "btn-signal" : "btn-ghost"}`} aria-label={listening ? P.voiceStop : P.voiceStart} aria-pressed={listening}><Icon name="mic" size={18} /></button>
          <button onClick={addNote} className="btn btn-ink shrink-0" aria-label={P.addNote}><Icon name="plus" size={18} /></button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {listening && dictStart !== null && (
            <span role="timer" className="chip num" data-testid="dictation-timer">
              <span aria-hidden className="size-2 rounded-full bg-[var(--color-ember)] motion-safe:animate-pulse" />
              {tf(P.recording, { time: formatElapsed(Math.max(tick, dictStart) - dictStart) })}
            </span>
          )}
          {note.trim().length > 1 && (
            <button type="button" onClick={structure} className={`btn !min-h-9 !px-3 text-[13px] ${dictated && !listening ? "btn-signal" : "btn-ghost"}`} aria-label={P.structureAria} data-testid="memo-structure">
              <Icon name="spark" size={15} /> {P.structure}
            </button>
          )}
        </div>
        {todos && <MemoSuggestions contactId={id} items={todos} onChange={setTodos} onCreated={load} />}
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold">{P.timeline}</h2>
          <button type="button" onClick={() => setEncOpen(!encOpen)} aria-expanded={encOpen} className="btn btn-ghost !min-h-10 !px-3 text-[14px]">
            <Icon name="plus" size={16} />{P.encRecord}
          </button>
        </div>
        {encOpen && (
          <form
            className="surface mb-5 grid gap-2 p-4 sm:grid-cols-2"
            aria-label={P.encRecord}
            onSubmit={(e) => {
              e.preventDefault();
              addEncounter();
            }}
          >
            <input className="field" placeholder={P.encPlacePh} aria-label={P.encPlace} maxLength={200} value={enc.place} onChange={(e) => setEnc({ ...enc, place: e.target.value })} />
            <input type="date" className="field" aria-label={P.encDate} max={today()} value={enc.date} onChange={(e) => setEnc({ ...enc, date: e.target.value })} />
            <textarea className="field min-h-20 sm:col-span-2" placeholder={P.encNotePh} aria-label={P.encNote} maxLength={2000} value={enc.note} onChange={(e) => setEnc({ ...enc, note: e.target.value })} />
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" disabled={busy || (!enc.place.trim() && !enc.note.trim())} className="btn btn-signal">{P.encSave}</button>
              <button type="button" onClick={() => setEncOpen(false)} className="btn btn-ghost">{m.common.cancel}</button>
            </div>
          </form>
        )}
        <ol className="relative space-y-5 border-l border-[var(--line-strong)] pl-6">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[37px] grid size-7 place-items-center rounded-full border border-[var(--line-strong)] bg-[var(--bg)]">
                <Icon name={e.icon} size={14} />
              </span>
              <p className="text-[12px] text-[var(--fg-mute)]">{fmtDate(e.at, { year: "numeric", month: "short", day: "numeric" }, lang)} · {relTime(e.at, lang)}</p>
              <p className="font-semibold">{e.title} {e.tag && <span className="chip ml-1 !py-0.5 text-[11px]"><Icon name="lock" size={11} />{e.tag}</span>}</p>
              {e.body && <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] text-[var(--fg-mute)]">{e.body}</p>}
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href={`/app/meetings/new?contact=${id}`} className="btn btn-ghost"><Icon name="calendar" size={17} />{P.newMeeting}</Link>
        <Link href={`/app/intros?a=${id}`} className="btn btn-ghost"><Icon name="room" size={17} />{P.introduce}</Link>
      </div>
    </div>
  );
}
