/**
 * P-180 워크스페이스 루트 레이아웃 · P-030 메타데이터.
 *
 * 폰트는 node_modules 에서 직접 self-host 한다 (next/font localFont):
 * CSP 의 font-src 가 'self' data: 뿐이고(P-042), 외부 CDN 을 허용하면 N-10 을 지키는 의미가 줄어든다.
 * 한글은 Pretendard(globals.css 의 dynamic-subset)가 받는다 — Instrument Serif 에는 한글 글리프가 없다.
 */

import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const serif = localFont({
  src: [
    { path: "../../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2", style: "normal", weight: "400" },
    { path: "../../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2", style: "italic", weight: "400" },
  ],
  variable: "--font-serif",
  display: "swap",
});

const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN ?? "http://localhost:4400"),
  title: { default: "PROPLUS — 사람이 브랜드가 되는 곳", template: "%s · PROPLUS" },
  // 브랜드 §4 서브카피를 그대로 쓴다.
  description: "경력과 전문성을 보여주고, 확인 가능한 신뢰를 쌓고, 나만의 페이지에서 고객과 연결하세요.",
  applicationName: "PROPLUS",
  openGraph: {
    title: "PROPLUS",
    description: "믿고 거래할 사람을 찾는 플랫폼. 확인 방식과 확인일을 함께 표시합니다.",
    type: "website",
  },
  // 공개 프로필은 각 페이지가 robots 를 직접 정한다 (미발행 프로필은 noindex — P-030).
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1522" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // lang="ko": 번들이 한국어 단일 로케일을 전제한다(다국어는 전략 §5 Stage E).
  // 스크린리더 발음과 word-break: keep-all 동작이 lang 에 달려 있어서 하드코딩이 맞다.
  return (
    <html lang="ko" className={`${serif.variable} ${inter.variable}`}>
      <body className="min-h-dvh">
        <a className="skip-link" href="#main">
          본문으로 건너뛰기
        </a>
        {children}
      </body>
    </html>
  );
}
