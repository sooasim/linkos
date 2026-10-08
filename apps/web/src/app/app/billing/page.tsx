import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { BillingView } from "./BillingView";

export const metadata: Metadata = { title: "플랜·결제" };

// F-190~F-194 plans, usage meters, checkout, customer portal
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; reason?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <PageHeader back="/app/settings" eyebrow="Plan & Billing" title={<>플랜 · <em>사용량</em></>} />
      <BillingView checkout={sp.checkout ?? null} reason={sp.reason ?? null} />
    </div>
  );
}
