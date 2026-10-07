import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { Settings } from "./Settings";

export const metadata: Metadata = { title: "설정·연동" };

// UX-022 Integrations + UX-023 Export + Privacy
export default function SettingsPage() {
  return (
    <div>
      <PageHeader eyebrow="Settings" title={<>연동 · 내보내기 · <em>개인정보</em></>} />
      <Settings />
    </div>
  );
}
