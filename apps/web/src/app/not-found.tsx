import Link from "next/link";
import { Logo } from "@/components/Icon";

export default function NotFound() {
  return (
    <main className="stage-ink grain flex min-h-dvh flex-col px-6 py-6">
      <div aria-hidden className="marks" />
      <Logo />
      <div className="my-auto">
        <p className="display text-[30vw] leading-none bg-gradient-to-b from-[#c8bdff] to-[#ffd6e6] bg-clip-text text-transparent sm:text-[220px]">404</p>
        <h1 className="display text-[44px]">찾는 페이지가 <em>없어요</em></h1>
        <Link href="/" className="btn btn-signal mt-8">처음으로</Link>
      </div>
    </main>
  );
}
