import { card } from "@linkos/api";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/Page";
import { getViewer } from "@/lib/server";
import { CardSmsFlow } from "./CardSmsFlow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "문자명함 전송" };

// X-009 문자명함 전송 — 상대의 종이 명함을 촬영하면, 거기서 읽은 번호로 내 명함(이미지 + 기본정보 + 저장 링크)을 문자로 보낸다.
export default async function CardSmsPage() {
  const { userId } = await getViewer();
  if (!(await card.primaryProfileId(userId!))) redirect("/app/me/edit?onboarding=1");
  return (
    <div>
      <PageHeader back="/app/people" eyebrow="Card by SMS" title={<>종이 명함을 받고 <em>문자로 답하기</em></>} />
      <CardSmsFlow />
    </div>
  );
}
