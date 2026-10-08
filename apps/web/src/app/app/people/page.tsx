import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/Page";
import { slot } from "@/lib/i18n";
import { getMessages } from "@/lib/i18n.server";
import { PeopleList } from "./PeopleList";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).m.nav.people };
}

// UX-011 People (F-177 ko/en)
export default async function PeoplePage() {
  const { m } = await getMessages();
  const [pre, post] = slot(m.people.title);
  return (
    <div>
      <PageHeader
        eyebrow="People"
        title={<>{pre}<em>{m.people.titleEm}</em>{post}</>}
        action={
          <Link href="/app/scan" className="btn btn-ink !min-h-11">
            <Icon name="scan" size={17} /> {m.people.scan}
          </Link>
        }
      />
      <PeopleList />
    </div>
  );
}
