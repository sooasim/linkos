import type { Metadata } from "next";
import { BoothMode } from "./BoothMode";

export const metadata: Metadata = { title: "부스 모드" };

// F-147 부스 Lead Flow · F-149 Event ROI · F-151 주최자 API 토큰
export default async function BoothPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BoothMode id={id} />;
}
