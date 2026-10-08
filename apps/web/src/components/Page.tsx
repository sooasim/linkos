import Link from "next/link";
import { Icon } from "./Icon";

export function PageHeader({ eyebrow, title, back, action }: { eyebrow?: string; title: React.ReactNode; back?: string; action?: React.ReactNode }) {
  return (
    <header className="mb-6 animate-rise">
      {back && (
        <Link href={back} className="mb-4 inline-flex items-center gap-1 text-[14px] font-medium text-[var(--fg-mute)] hover:text-[var(--fg)]">
          <Icon name="back" size={16} /> 뒤로
        </Link>
      )}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="display mt-1.5 text-[44px] sm:text-[56px]">{title}</h1>
        </div>
        {action}
      </div>
    </header>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="surface flex flex-col items-start gap-3 p-6">
      <p className="text-[17px] font-semibold">{title}</p>
      {body && <p className="text-[14.5px] text-[var(--fg-mute)]">{body}</p>}
      {action}
    </div>
  );
}

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  const bg = ["#e6e1ff", "#ffe2d6", "#d9eaff", "#d8f3e7"][hue];
  const fg = "#2a2550";
  return (
    <span className="display grid shrink-0 place-items-center rounded-full" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.48 }} aria-hidden>
      {initial}
    </span>
  );
}

export function AiLabel({ children = "AI 추론" }: { children?: React.ReactNode }) {
  return <span className="chip chip-ai">{children}</span>;
}
