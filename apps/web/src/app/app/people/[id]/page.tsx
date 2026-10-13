import type { Metadata } from "next";
import { PersonDetail } from "./PersonDetail";
import { RelationshipIntel } from "./RelationshipIntel";
import { RolesPanel } from "./RolesPanel";
import { StrengthPanel } from "./StrengthPanel";

export const metadata: Metadata = { title: "인맥 상세" };

// UX-012 Person Detail + UX-013 Merge Review + F-074 관계 강도
// N-008 소속 이력 · N-103/N-104/N-109/N-022 관계 인텔리전스 (S05/S15 · docs/NETWORK_INTELLIGENCE.md)
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PersonDetail id={id} />
      <StrengthPanel id={id} />
      <RolesPanel id={id} />
      <RelationshipIntel id={id} />
    </>
  );
}
