"use client";
// LINKOS console — shared context + presentational primitives.
// Primitives mirror the string helpers in the prototype (kpi, hd, btn, sec, pill, bar, activity, rows, spark, help).
import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "./icons";
import { ORGS, ROLES, type Model, type Role } from "./config";

export type SuiteCtxValue = {
  model: Model;
  role: Role;
  tenant: string;
  chapter: string;
  go: (page: string) => void;
  action: (key: string) => void;
  setSearch: (v: string) => void;
  setConsent: (id: string, checked: boolean) => void;
};

const SuiteContext = createContext<SuiteCtxValue | null>(null);
export const SuiteProvider = SuiteContext.Provider;
export function useSuite(): SuiteCtxValue {
  const v = useContext(SuiteContext);
  if (!v) throw new Error("useSuite must be used within <SuiteProvider>");
  return v;
}

/* ── primitives ───────────────────────────────────────────────── */

export function Btn({ label, act, variant = "", icon }: { label: ReactNode; act: string; variant?: string; icon?: string }) {
  const { action } = useSuite();
  return (
    <button type="button" className={`btn ${variant}`.trim()} onClick={() => action(act)}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {label}
    </button>
  );
}

export function GoBtn({ to, className = "small-link", children }: { to: string; className?: string; children: ReactNode }) {
  const { go } = useSuite();
  return (
    <button type="button" className={className} onClick={() => go(to)}>
      {children}
    </button>
  );
}

export function Kpi({ label, value, foot, icon = "chart", tone = "green" }: { label: ReactNode; value: ReactNode; foot: ReactNode; icon?: string; tone?: string }) {
  return (
    <div className="card small">
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className={`kpi-icon ${tone}`}>
          <Icon name={icon} size={17} />
        </span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot">{foot}</div>
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  const { role } = useSuite();
  const r = ROLES[role];
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">
          {r.caption} / {r.name}
        </div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className="actions">{actions}</div>
    </header>
  );
}

export function Sec({ title, more }: { title: ReactNode; more?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {more}
    </div>
  );
}

export function Pill({ tone = "", children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill ${tone}`.trim()}>{children}</span>;
}

export function Bar({ label, value, num }: { label: ReactNode; value: number; num: ReactNode }) {
  return (
    <div className="bar-row">
      <div className="bar-label">
        <span>{label}</span>
        <strong>{num}</strong>
      </div>
      <div className="progress">
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function Activity({ title, sub, when, icon = "link" }: { title: ReactNode; sub: ReactNode; when: ReactNode; icon?: string }) {
  return (
    <div className="activity">
      <span className="dot">
        <Icon name={icon} size={16} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{sub}</p>
      </div>
      <time>{when}</time>
    </div>
  );
}

export function Table({ heads, rows }: { heads: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-scroll">
      <table className="list-table">
        <thead>
          <tr>
            {heads.map((x, i) => (
              <th key={i} scope="col">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Spark() {
  return (
    <svg className="spark" viewBox="0 0 540 108" preserveAspectRatio="none" role="img" aria-label="최근 6주 예시 추세: 완만하게 상승">
      <path className="axis" d="M0 25H540M0 60H540M0 95H540" />
      <path className="area" d="M4 90L70 72L130 80L193 47L266 66L335 41L410 48L480 18L536 25V108H4z" />
      <path className="line" d="M4 90L70 72L130 80L193 47L266 66L335 41L410 48L480 18L536 25" />
    </svg>
  );
}

export function Help({ children }: { children: ReactNode }) {
  return (
    <div className="helpbar">
      <Icon name="shield" size={14} /> {children}
    </div>
  );
}

export function OrgCards() {
  const { model, action } = useSuite();
  const list = ORGS.filter((o) => !model.search || o.join(" ").toLowerCase().includes(model.search.toLowerCase()));
  if (!list.length) {
    return (
      <div className="card empty">
        <strong>검색 결과가 없습니다.</strong>다른 업종 또는 기업명을 입력하세요.
      </div>
    );
  }
  return (
    <>
      {list.map((o, i) => (
        <div className="card" key={i}>
          <div className="row-title">
            <span className="initial">{(o[0] ?? "").slice(0, 2)}</span>
            <div>
              <strong style={{ fontSize: 13 }}>{o[0]}</strong>
              <div className="tiny muted" style={{ marginTop: 3 }}>
                {o[1]} · {o[3]}
              </div>
            </div>
          </div>
          <p className="tiny muted" style={{ margin: "19px 0", lineHeight: 1.7, minHeight: 39 }}>
            {o[2]}
          </p>
          <div className="line">
            <span>
              <Pill>{o[4]}</Pill>
            </span>
            <button type="button" className="btn" onClick={() => action("newIntro")}>
              <Icon name="arrow" size={14} />
              소개 요청
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
