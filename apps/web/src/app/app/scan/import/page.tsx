import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { BatchImport } from "./BatchImport";

export const metadata: Metadata = { title: "명함 일괄 가져오기" };

// F-012 사진첩 일괄 가져오기 · F-013 다중 명함 분리 · F-178 오프라인 캡처 처리
export default function ImportPage() {
  return (
    <div>
      <PageHeader back="/app/scan" eyebrow="Capture · Batch" title={<>사진첩 <em>가져오기</em></>} />
      <BatchImport />
    </div>
  );
}
