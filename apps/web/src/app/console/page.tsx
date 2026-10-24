import Link from "next/link";
import { DEFAULT_CHAPTER, DEFAULT_TENANT, ROLES, routeFor, type Role } from "./config";

const ORDER: Role[] = ["member", "chapter", "tenant", "platform"];

export default function ConsoleHome() {
  return (
    <div className="content" style={{ maxWidth: 1100 }}>
      <header className="page-head">
        <div>
          <div className="eyebrow">LINKOS · BUSINESS OPERATING SYSTEM</div>
          <h1>역할별 대시보드 콘솔</h1>
          <p>회원 · 챕터 운영자 · 기관 관리자 · 플랫폼 관리자 — 4역할 × 6화면 = 24개 UI/UX 시안. 모든 데이터는 가상이며 실제 로그인·저장·결제·AI 처리는 연결되지 않았습니다.</p>
        </div>
      </header>
      <section className="grid4">
        {ORDER.map((role) => {
          const r = ROLES[role];
          return (
            <Link key={role} href={routeFor(role, "home", DEFAULT_TENANT, DEFAULT_CHAPTER)} className="card" style={{ display: "block" }}>
              <div className="eyebrow">{r.caption}</div>
              <h2 style={{ fontSize: 17, margin: "8px 0 10px" }}>{r.name}</h2>
              <p className="tiny muted" style={{ lineHeight: 1.7, minHeight: 34 }}>{r.who}</p>
              <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
                {r.nav.map((n) => (
                  <li key={n.key} className="tiny muted">· {n.title}</li>
                ))}
              </ul>
            </Link>
          );
        })}
      </section>
      <footer className="footer-help">LINKOS UI/UX specification preview v2.0 · 2026.10.24 · 독립형 비즈니스 커뮤니티 SaaS · BNI 공식 제품 아님</footer>
    </div>
  );
}
