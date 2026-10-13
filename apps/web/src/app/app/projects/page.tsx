import type { Metadata } from "next";
import { PageHeader } from "@/components/Page";
import { ProjectsHub } from "./ProjectsHub";

export const metadata: Metadata = { title: "프로젝트" };

// N-018 Role/Need 분해 · N-019 커버리지와 Network Gap (S10 Project Command Center)
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <PageHeader eyebrow="Project Network" title={<>이 일을 하려면 <em>누가</em> 필요한가요?</>} />
      <ProjectsHub initialId={sp.id ?? null} />
    </div>
  );
}
