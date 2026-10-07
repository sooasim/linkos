import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { Integrations } from "./Integrations";

export const metadata: Metadata = { title: "CRM·자동화 연동" };

// F-119~F-122 CRM/Microsoft · F-127 필드 매핑 · F-128 Sync Journal · F-123 Webhooks
export default function IntegrationsPage() {
  return (
    <div>
      <PageHeader back="/app/settings" eyebrow="Integrations" title={<>CRM · <em>자동화</em></>} />
      <Integrations />
    </div>
  );
}
