import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { ScanFlow } from "./ScanFlow";

export const metadata: Metadata = { title: "명함 스캔" };

// UX-006/007 Scan → Review (owner) + 중복 탐지 (F-010~F-021)
export default function ScanPage() {
  return (
    <div>
      <PageHeader back="/app/people" eyebrow="Capture" title={<>명함 <em>스캔</em></>} />
      <ScanFlow />
    </div>
  );
}
