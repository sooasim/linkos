import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Fx } from "@/components/Fx";
import { I18nProvider } from "@/components/I18n";
import { ServiceWorker } from "@/components/ServiceWorker";
import { getLocale } from "@/lib/i18n.server";
import { WebVitals } from "./WebVitals";

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
  metadataBase: new URL(process.env.APP_ORIGIN ?? "http://localhost:3000"),
  title: { default: "LINKOS — Business Identity & Relationship OS", template: "%s · LINKOS" },
  description: "만나는 순간부터 관계를 기억하고, 다음 행동과 사업 기회까지. 가입 없이 교환하는 살아있는 명함.",
  applicationName: "LINKOS",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "LINKOS", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  openGraph: { title: "LINKOS", description: "Meet → Exchange → Remember → Act. 가입 없이 교환하는 Living Card.", type: "website" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfe" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f17" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // F-177: <html lang> follows the chosen app language (cookie lk_lang; default ko). Guest pages additionally mark
  // their negotiated locale on <main lang>.
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${serif.variable} ${inter.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh">
        <I18nProvider locale={locale}>{children}</I18nProvider>
        <Fx />
        <ServiceWorker />
        <WebVitals />
      </body>
    </html>
  );
}
