"use client";
// F-010 교환 끝단 — 상대 명함을 스캔해 저장한 뒤, "휴대폰 기본 메시지"로 내 명함(정보+이미지)을
// 그 상대에게 보내고, 원하면 내 폰에도 인식 결과를 기록으로 남긴다. 서버가 자동 발송하지 않는다:
// 이미지가 붙는 경로는 Web Share(OS 공유 시트)뿐이고, 번호가 자동 채워지는 경로는 sms: 링크뿐이라
// 둘을 나란히 둔다(비타협 원칙 3·4·8). 메시지는 모두 사용자가 메시지 앱에서 직접 보낸다.
import { type MyCard, buildMyCardMessage, buildScanRecordMessage, smsHref } from "@linkos/domain";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/client";

export interface ScannedContact {
  fullName: string | null;
  company?: string | null;
  jobTitle?: string | null;
  phone: string | null;
  email?: string | null;
  place?: string | null;
}

async function shareFilesSupported(file: File): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (d?: ShareData & { files?: File[] }) => boolean };
  return typeof navigator.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
}

export function SendMyCard({ contact }: { contact: ScannedContact }) {
  const [me, setMe] = useState<MyCard | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api<{ user: { email: string | null; display_name: string | null }; profile: { id: string; slug: string; name: string } | null }>("/me");
        if (!r.profile) return;
        const base: MyCard = {
          name: r.profile.name || r.user.display_name || "",
          email: r.user.email,
          url: typeof location !== "undefined" ? `${location.origin}/p/${r.profile.slug}` : null,
        };
        // 직함·회사·연락처는 내 명함 상세에서 best-effort 로 채운다(없으면 생략, 지어내지 않음).
        try {
          const p = await api<Record<string, unknown>>(`/profiles/${r.profile.id}`);
          base.jobTitle = (p.jobTitle as string) ?? null;
          base.company = (p.company as string) ?? null;
          base.phone = (p.phone as string) ?? (p.mobile as string) ?? null;
          if (!base.email) base.email = (p.email as string) ?? null;
        } catch {
          /* 상세를 못 불러와도 이름·이메일·링크로 보낼 수 있다 */
        }
        if (alive) setMe(base);
      } catch {
        /* 로그인 전/오류 — 버튼은 숨긴다 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!me) return null;

  const myText = buildMyCardMessage(me, { recipientName: contact.fullName });

  const sendMyCard = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const { renderMyCardImage } = await import("@/lib/cardImage");
      const blob = await renderMyCardImage(me).catch(() => null);
      const file = blob ? new File([blob], "my-card.png", { type: "image/png" }) : null;
      if (file && (await shareFilesSupported(file))) {
        await navigator.share({ files: [file], text: myText, title: "내 명함" });
        setFlash("공유 시트에서 메시지(문자)를 골라 보내세요. 명함 이미지가 함께 첨부됩니다.");
        return;
      }
      if (typeof navigator.share === "function") {
        await navigator.share({ text: myText, title: "내 명함", url: me.url ?? undefined });
        setFlash("공유 시트에서 메시지(문자)를 골라 보내세요.");
        return;
      }
      // 공유 API가 없으면 번호로 바로 문자(텍스트) — 이미지는 못 붙는다.
      location.href = smsHref(contact.phone, myText);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setFlash("공유를 열지 못했어요. 아래 ‘번호로 바로 문자’를 이용해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const recordText = buildScanRecordMessage(contact, contact.place);

  return (
    <section className="surface space-y-3 p-4" aria-label="내 명함 보내기">
      <div className="flex items-center gap-2">
        <Icon name="send" size={18} />
        <h2 className="text-[16px] font-semibold">내 명함 문자로 보내기</h2>
      </div>
      <p className="text-[13px] text-[var(--fg-mute)]">
        방금 스캔한 {contact.fullName ?? "상대"}님에게 내 명함(정보 + 이미지)을 휴대폰 메시지로 보냅니다. 발송은 메시지 앱에서 직접 확인하고 보냅니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-signal !min-h-10 text-[14px]" disabled={busy} onClick={sendMyCard}>
          <Icon name="send" size={16} /> 내 명함 보내기 (이미지 포함)
        </button>
        {contact.phone && (
          <a className="btn btn-ghost !min-h-10 text-[14px]" href={smsHref(contact.phone, myText)}>
            이 번호로 바로 문자 (텍스트)
          </a>
        )}
        <a className="btn btn-ghost !min-h-10 text-[14px]" href={smsHref(null, recordText)}>
          내 폰에 기록
        </a>
      </div>
      {flash && <p className="text-[13px]" role="status">{flash}</p>}
    </section>
  );
}
