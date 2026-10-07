"use client";
// UX-010 Card Editor: 필드·공개범위·audience variant·preview (F-022~F-036) + X-008 템플릿·아이콘 꾸미기
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ResolvedGlyph } from "@linkos/domain/cardDesign";
import { CardScanner, type OcrLineOut } from "@/components/CardScanner";
import { type DesignState, cleanOptions, designFromState, initialDesignState, withGlyph } from "@/components/cardTemplates/designState";
import { TemplateStudio } from "@/components/cardTemplates/TemplateStudio";
import { GlyphButton } from "@/components/iconBank/GlyphButton";
import { Icon } from "@/components/Icon";
import { CardFace, OfferNeed } from "@/components/LivingCard";
import { PageHeader } from "@/components/Page";
import { api } from "@/lib/client";
import { CardIntel } from "./CardIntel";

type Vis = "public" | "business" | "trusted" | "partner" | "private";
type FieldRow = { type: string; label?: string | null; value: string; visibility: Vis };
const VIS: { v: Vis; label: string; hint: string }[] = [
  { v: "public", label: "공개", hint: "누구나" },
  { v: "business", label: "비즈니스", hint: "교환한 상대" },
  { v: "trusted", label: "신뢰", hint: "승인한 사람" },
  { v: "partner", label: "파트너", hint: "파트너만" },
  { v: "private", label: "비공개", hint: "나만" },
];
const FIELD_TYPES = [
  ["email", "이메일"],
  ["mobile", "휴대폰"],
  ["phone", "전화"],
  ["website", "웹사이트"],
  ["address", "주소"],
  ["linkedin", "LinkedIn"],
  ["booking", "미팅 예약 링크"],
  ["kakao", "카카오톡"],
  ["other", "기타"],
] as const;
const THEMES = ["ink", "paper", "signal", "ember"] as const;
const AUDIENCES = [
  ["investor", "투자자"],
  ["customer", "고객"],
  ["partner", "파트너"],
  ["recruiting", "채용"],
] as const;

function ListEditor({ label, items, onChange, placeholder, max = 10, addon }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; max?: number; addon?: React.ReactNode }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v) && items.length < max) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div>
      {addon ? (
        <div className="mb-1.5 flex items-center gap-2">
          {addon}
          <span className="label !mb-0">{label}</span>
        </div>
      ) : (
        <span className="label">{label}</span>
      )}
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <span key={it} className="chip">
            {it}
            <button type="button" aria-label={`${it} 삭제`} onClick={() => onChange(items.filter((x) => x !== it))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input className="field" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" onClick={add} className="btn btn-ghost shrink-0" aria-label={`${label} 추가`}>
          <Icon name="plus" size={18} />
        </button>
      </div>
    </div>
  );
}

type GlyphMapKey = "fieldIcons" | "keywordBadges" | "sectionIcons";

export function CardEditor({ profile, onboarding, initialTab = "info" }: { profile: any | null; onboarding: boolean; initialTab?: "info" | "template" }) {
  const router = useRouter();
  const [tab, setTab] = useState<"info" | "template">(initialTab);
  const [design, setDesign] = useState<DesignState>(() => initialDesignState(profile?.design, profile?.templateOptions));
  const glyphOf = (ref: string | undefined) => (ref ? (design.glyphs[ref] ?? null) : null);
  const setGlyph = (map: GlyphMapKey, key: string, g: ResolvedGlyph | null) =>
    setDesign((s) => ({ ...withGlyph(s, g), options: { ...s.options, [map]: { ...(s.options[map] ?? {}), [key]: g?.ref } } }));
  const [p, setP] = useState(() => ({
    name: profile?.name ?? "",
    company: profile?.company ?? "",
    jobTitle: profile?.jobTitle ?? "",
    headline: profile?.headline ?? "",
    bioShort: profile?.bioShort ?? "",
    keywords: (profile?.keywords ?? []) as string[],
    industries: (profile?.industries ?? []) as string[],
    regions: (profile?.regions ?? []) as string[],
    theme: (profile?.theme ?? "ink") as (typeof THEMES)[number],
    matchingOptIn: profile?.matchingOptIn ?? true,
    fields: ((profile?.fields ?? []) as FieldRow[]).map((f): FieldRow => ({ type: f.type, label: f.label, value: f.value, visibility: f.visibility })),
    offers: ((profile?.offers ?? []) as { text: string }[]).map((o) => o.text),
    needs: ((profile?.needs ?? []) as { text: string }[]).map((o) => o.text),
    deep: { projects: [], achievements: [], services: [], assets: [], network: [], interests: [], languages: [], ...(profile?.deep ?? {}) } as Record<string, any>,
    variants: (profile?.variants ?? []).map((v: any) => ({ audience: v.audience, headline: v.content?.headline ?? "", isDefault: v.isDefault })) as { audience: string; headline: string; isDefault: boolean }[],
  }));
  const [scan, setScan] = useState(onboarding && !profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((s) => ({ ...s, [k]: v }));
  // the card face shows what an exchange recipient sees (public + business fields)
  const previewFields = p.fields.filter((f) => f.value.trim() && (f.visibility === "public" || f.visibility === "business"));

  const fromScan = async (lines: OcrLineOut[]) => {
    const r = await api<{ fields: { key: string; value: string }[] }>("/capture/parse", { body: { lines: lines.map((l) => ({ text: l.text, confidence: l.confidence })) } });
    const get = (k: string) => r.fields.find((f) => f.key === k)?.value ?? "";
    const fields: FieldRow[] = [];
    for (const [k, type] of [["email", "email"], ["mobile", "mobile"], ["phone", "phone"], ["website", "website"], ["address", "address"]] as const) {
      const v = get(k);
      if (v) fields.push({ type, value: v, visibility: type === "address" || type === "mobile" ? "trusted" : "business" });
    }
    setP((s) => ({ ...s, name: get("fullName") || s.name, company: get("company") || s.company, jobTitle: get("jobTitle") || s.jobTitle, fields: fields.length ? fields : s.fields }));
    setScan(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      ...p,
      company: p.company || null,
      jobTitle: p.jobTitle || null,
      headline: p.headline || null,
      bioShort: p.bioShort || null,
      fields: p.fields.filter((f) => f.value.trim()),
      deep: { ...p.deep, projects: (p.deep.projects ?? []).filter((x: any) => x.title) },
      variants: p.variants.filter((v) => v.headline).map((v) => ({ audience: v.audience, headline: v.headline, isDefault: v.isDefault })),
      templateId: design.template?.id ?? null,
      templateOptions: cleanOptions(design, p.keywords),
      version: profile?.version,
    };
    try {
      if (profile) await api(`/profiles/${profile.id}`, { method: "PATCH", body });
      else await api("/profiles", { body });
      router.push(onboarding ? "/app?welcome=1" : "/app/me");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader back={onboarding ? undefined : "/app/me"} eyebrow={onboarding ? "Welcome · 1분이면 충분해요" : "Card Editor"} title={profile ? <>카드 <em>편집</em></> : <>내 <em>Living Card</em> 만들기</>} />

      <div role="tablist" aria-label="편집 단계" className="surface mb-6 flex p-1">
        {(
          [
            ["info", "카드 정보"],
            ["template", "템플릿 · 꾸미기"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`edit-tab-${k}`} aria-controls={`edit-panel-${k}`} aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`edit-tab-${k}`} className={`flex-1 rounded-[16px] py-2.5 text-[14px] font-semibold transition ${tab === k ? "bg-[var(--fg)] text-[var(--bg)]" : "text-[var(--fg-mute)]"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        {tab === "template" ? (
          <div role="tabpanel" id="edit-panel-template" aria-labelledby="edit-tab-template" className="space-y-6">
            <TemplateStudio
              profile={{ name: p.name, company: p.company, jobTitle: p.jobTitle, headline: p.headline, keywords: p.keywords, industries: p.industries, bioShort: p.bioShort, fields: previewFields }}
              state={design}
              onChange={setDesign}
            />
            <a href="/app/me/templates" className="btn btn-ghost w-full">
              <Icon name="layers" size={16} /> 전체 화면 갤러리에서 보기
            </a>
          </div>
        ) : (
        <div role="tabpanel" id="edit-panel-info" aria-labelledby="edit-tab-info" className="space-y-8">
          {scan ? (
            <section className="space-y-3">
              <p className="text-[15px] text-[var(--fg-mute)]">종이 명함이 있다면 촬영해서 바로 채워보세요.</p>
              <CardScanner onLines={fromScan} onManual={() => setScan(false)} compact />
            </section>
          ) : null}

          <section className="space-y-4">
            <h2 className="eyebrow">3초 카드</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className="label">이름 *</span>
                <input className="field" name="name" value={p.name} onChange={(e) => set("name", e.target.value)} required maxLength={80} />
              </label>
              <label>
                <span className="label">회사</span>
                <input className="field" name="company" value={p.company} onChange={(e) => set("company", e.target.value)} maxLength={120} />
              </label>
              <label>
                <span className="label">직책</span>
                <input className="field" name="jobTitle" value={p.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} maxLength={120} />
              </label>
              <label className="sm:col-span-2">
                <span className="label">한 줄 소개</span>
                <input className="field" value={p.headline} onChange={(e) => set("headline", e.target.value)} placeholder="예: 의료 AI로 판독 시간을 절반으로" maxLength={160} />
              </label>
            </div>
            <ListEditor label="핵심 키워드 (최대 3개)" items={p.keywords} onChange={(v) => set("keywords", v)} placeholder="예: 의료AI" max={3} />
            {p.keywords.length > 0 && (
              <div className="flex flex-wrap items-center gap-2" aria-label="키워드 배지">
                <span className="text-[13px] text-[var(--fg-mute)]">키워드 배지</span>
                {p.keywords.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1.5">
                    <GlyphButton compact label={`‘${k}’ 키워드 배지`} value={glyphOf(design.options.keywordBadges?.[k])} onChange={(g) => setGlyph("keywordBadges", k, g)} />
                    <span className="text-[13px]">#{k}</span>
                  </span>
                ))}
              </div>
            )}
            <div>
              <span className="label">카드 테마</span>
              <div className="flex gap-2">
                {THEMES.map((t) => (
                  <button key={t} type="button" aria-label={`${t} 테마`} aria-pressed={p.theme === t} onClick={() => set("theme", t)} className={`theme-${t} size-11 rounded-full ring-offset-2 ring-offset-[var(--bg)] transition ${p.theme === t ? "ring-2 ring-[var(--fg)]" : ""}`} />
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="eyebrow">연락처 · 공개범위</h2>
            {p.fields.map((f, i) => (
              <div key={i} className="surface grid grid-cols-[auto_110px_1fr_auto] items-center gap-2 p-2 sm:grid-cols-[auto_120px_1fr_130px_auto]">
                <GlyphButton compact label={`${FIELD_TYPES.find(([v]) => v === f.type)?.[1] ?? f.type} 아이콘`} value={glyphOf(design.options.fieldIcons?.[f.type])} onChange={(g) => setGlyph("fieldIcons", f.type, g)} />
                <select className="field !min-h-11 !py-2 !text-[14px]" value={f.type} aria-label="항목 종류" onChange={(e) => set("fields", p.fields.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <input className="field !min-h-11 !py-2" value={f.value} aria-label="값" onChange={(e) => set("fields", p.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <select className="field col-span-3 !min-h-11 !py-2 !text-[14px] sm:col-span-1" value={f.visibility} aria-label="공개범위" onChange={(e) => set("fields", p.fields.map((x, j) => (j === i ? { ...x, visibility: e.target.value as Vis } : x)))}>
                  {VIS.map((v) => <option key={v.v} value={v.v}>{v.label} · {v.hint}</option>)}
                </select>
                <button type="button" aria-label="항목 삭제" className="grid size-11 place-items-center text-[var(--fg-mute)]" onClick={() => set("fields", p.fields.filter((_, j) => j !== i))}>
                  <Icon name="trash" size={18} />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => set("fields", [...p.fields, { type: "email", value: "", visibility: "business" }])}>
              <Icon name="plus" size={18} /> 항목 추가
            </button>
          </section>

          <section className="space-y-4">
            <h2 className="eyebrow">30초 카드 · Offer / Need</h2>
            <label className="block">
              <span className="label">소개</span>
              <textarea className="field min-h-24" value={p.bioShort} onChange={(e) => set("bioShort", e.target.value)} maxLength={400} />
            </label>
            <ListEditor label="Offer — 내가 줄 수 있는 것" items={p.offers} onChange={(v) => set("offers", v)} placeholder="예: 의료 영상 AI 솔루션" />
            <ListEditor label="Need — 지금 필요한 것" items={p.needs} onChange={(v) => set("needs", v)} placeholder="예: 병원 유통 파트너" />
            <div className="grid gap-4 sm:grid-cols-2">
              <ListEditor label="산업" items={p.industries} onChange={(v) => set("industries", v)} placeholder="예: 헬스케어" max={8} />
              <ListEditor label="활동 지역" items={p.regions} onChange={(v) => set("regions", v)} placeholder="예: 서울" max={8} />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="eyebrow">딥 프로필</h2>
            <ListEditor
              label="프로젝트"
              addon={<GlyphButton compact label="프로젝트 섹션 아이콘" value={glyphOf(design.options.sectionIcons?.projects)} onChange={(g) => setGlyph("sectionIcons", "projects", g)} />}
              items={(p.deep.projects ?? []).map((x: any) => x.title)}
              onChange={(v) => set("deep", { ...p.deep, projects: v.map((title) => ({ title })) })}
              placeholder="진행 중인 프로젝트"
              max={12}
            />
            {(
              [
                ["achievements", "성과"],
                ["services", "서비스"],
                ["assets", "보유 자원 (유통망/시설/기술)"],
                ["network", "연결 가능한 네트워크"],
                ["interests", "관심 분야"],
                ["languages", "언어"],
              ] as const
            ).map(([k, label]) => (
              <ListEditor
                key={k}
                label={label}
                addon={<GlyphButton compact label={`${label} 섹션 아이콘`} value={glyphOf(design.options.sectionIcons?.[k])} onChange={(g) => setGlyph("sectionIcons", k, g)} />}
                items={p.deep[k] ?? []}
                onChange={(v) => set("deep", { ...p.deep, [k]: v })}
                placeholder={label}
                max={12}
              />
            ))}
            {profile?.id && (
              <a href="/app/me/media" className="btn btn-ghost w-full">
                <Icon name="plus" size={16} /> 포트폴리오 이미지 · PDF 관리
              </a>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="eyebrow">상대별 카드 변형</h2>
            {AUDIENCES.map(([a, label]) => {
              const v = p.variants.find((x) => x.audience === a);
              return (
                <label key={a} className="block">
                  <span className="label">{label}에게 보일 한 줄</span>
                  <input
                    className="field"
                    value={v?.headline ?? ""}
                    onChange={(e) => set("variants", [...p.variants.filter((x) => x.audience !== a), { audience: a, headline: e.target.value, isDefault: false }])}
                    maxLength={160}
                  />
                </label>
              );
            })}
            <label className="flex items-center gap-3 pt-2 text-[15px]">
              <input type="checkbox" className="size-5 accent-[var(--color-ink)]" checked={p.matchingOptIn} onChange={(e) => set("matchingOptIn", e.target.checked)} />
              Need↔Offer 매칭 추천에 내 공개 Offer/Need 사용 허용
            </label>
          </section>

          {profile && <CardIntel profileId={profile.id} hasVariants={(profile.variants ?? []).length > 0} />}
        </div>
        )}

        <aside className="lg:sticky lg:top-10 lg:self-start">
          <p className="eyebrow mb-3">미리보기</p>
          <CardFace card={{ ...p, fields: previewFields, design: designFromState(design) }} />
          {design.template && <p className="mt-2 text-[12.5px] text-[var(--fg-mute)]">템플릿 · {design.template.name.ko}</p>}
          <div className="mt-4">
            <OfferNeed offers={p.offers} needs={p.needs} />
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-24 z-30 px-5 lg:static lg:mt-8 lg:px-0">
        <div className="mx-auto max-w-3xl">
          {error && <p role="alert" className="mb-2 rounded-2xl bg-[var(--color-ember)]/10 px-4 py-2 text-[14px] text-[var(--color-ember)]">{error}</p>}
          <button onClick={save} disabled={saving || !p.name.trim()} className="btn btn-signal btn-lg w-full shadow-2xl lg:w-auto" data-testid="save-card">
            {saving ? "저장 중…" : profile ? "저장" : "카드 완성"}
          </button>
        </div>
      </div>
    </div>
  );
}
