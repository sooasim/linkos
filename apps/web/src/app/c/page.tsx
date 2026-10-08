"use client";
import { normalizeShortCode } from "@linkos/domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/Icon";
import { ReceiveMode } from "@/components/ReceiveMode";

// 단축코드 입력 (브라우저 즉시 수신)
export default function EnterCodePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [receiving, setReceiving] = useState(false);
  const valid = normalizeShortCode(code);
  return (
    <main className="stage-ink grain flex min-h-dvh flex-col px-6 pb-10 pt-6">
      <div aria-hidden className="marks" />
      <Logo />
      <form
        className="my-auto w-full max-w-md animate-rise"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) router.push(`/c/${valid}`);
        }}
      >
        <p className="eyebrow">lk.to</p>
        <h1 className="display mt-3 text-[56px]">
          코드로 <em>받기</em>
        </h1>
        <p className="mt-3 text-[16px] text-[var(--fg-mute)]">상대 화면에 보이는 숫자 4자리를 입력하세요. 가입은 필요 없어요.</p>
        <input
          autoFocus
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={5}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9０-９\s-]/g, ""))}
          aria-label="숫자 4자리 교환 코드"
          className="num mt-8 w-full rounded-[22px] border border-[var(--line-strong)] bg-transparent px-5 py-5 text-center text-[40px] font-semibold tracking-[0.5em] outline-none focus:border-[var(--color-signal)]"
          placeholder="0000"
        />
        <button className="btn btn-signal btn-lg mt-5 w-full" disabled={!valid}>
          명함 받기
        </button>
        {!receiving && (
          <button type="button" onClick={() => setReceiving(true)} className="btn btn-ghost mt-3 w-full" data-testid="receive-mode-start">
            코드가 없나요? 받기 모드로 페어링
          </button>
        )}
      </form>
      {/* F-046 웹-웹 페어링: the sender types this page's 4-digit code on their LINKOS exchange screen */}
      {receiving && (
        <div className="mx-auto mb-auto w-full max-w-md">
          <ReceiveMode onClose={() => setReceiving(false)} />
        </div>
      )}
    </main>
  );
}
