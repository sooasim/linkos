import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./suite.css";

export const metadata: Metadata = {
  title: "역할별 콘솔",
  description: "LINKOS 회원·챕터·기관·플랫폼 관리자 UI/UX 콘솔 (정적 시안 · 가상 데이터).",
};

// The whole console is scoped under .linkos-suite so the navy/teal design tokens from
// uiux/design_tokens.json never collide with the global "Porcelain & Pastel" theme.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="linkos-suite" lang="ko">
      {children}
    </div>
  );
}
