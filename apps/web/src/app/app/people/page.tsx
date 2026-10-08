import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/Page";
import { PeopleList } from "./PeopleList";

export const metadata: Metadata = { title: "인맥" };

// UX-011 People
export default function PeoplePage() {
  return (
    <div>
      <PageHeader
        eyebrow="People"
        title={<>나의 <em>인맥</em></>}
        action={
          <Link href="/app/scan" className="btn btn-ink !min-h-11">
            <Icon name="scan" size={17} /> 스캔
          </Link>
        }
      />
      <PeopleList />
    </div>
  );
}
