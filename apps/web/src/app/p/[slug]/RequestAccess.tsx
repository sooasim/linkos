"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";

export function RequestAccess({ profileId, signedIn }: { profileId: string; signedIn: boolean }) {
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  if (!signedIn) return <Link href="/login" className="btn btn-ghost mt-6 w-full">로그인하고 비공개 항목 요청</Link>;
  return (
    <button
      className="btn btn-ghost mt-6 w-full"
      disabled={state === "sent"}
      onClick={() => api(`/profiles/${profileId}/access-requests`, { body: { fields: ["trusted"] } }).then(() => setState("sent")).catch(() => setState("error"))}
    >
      {state === "sent" ? "요청을 보냈어요" : state === "error" ? "다시 시도" : "비공개 항목 공유 요청"}
    </button>
  );
}
