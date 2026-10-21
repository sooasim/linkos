"use client";
// X-009 문자로 받은 명함 랜딩. 수신자는 비회원이다 — 가입·로그인·앱설치를 요구하지 않고(§2.1),
// 첫 화면의 가장 큰 버튼이 "연락처에 저장"이다. 저장은 .vcf 한 장으로 끝난다:
// 안드로이드/구글 연락처 앱과 iOS 연락처가 모두 .vcf 를 열어 "연락처 추가" 화면을 띄운다.
// 자동으로 상대 구글 계정에 써 넣는 링크는 존재하지 않으므로, 할 수 없는 일을 할 수 있는 척 하지 않는다(§2.4).
import { GOOGLE_CONTACTS_URL, type Locale } from "@linkos/domain";
import Link from "next/link";
import { useState } from "react";
import { Icon, Logo } from "@/components/Icon";
import { type CardData, LivingCard } from "@/components/LivingCard";

interface Landing {
  deliveryId: string;
  /** 보낸 사람의 Living Card — 서버가 교환과 같은 audience(business)로 투영한 결과만 온다 */
  sender: CardData & { id: string; slug: string };
  imageUrl: string | null;
  toName: string | null;
  vcardPath: string;
  expiresAt: string;
}

const T = {
  ko: {
    eyebrow: "문자로 받은 명함",
    hello: (to: string | null) => (to ? `${to}님께 도착한 명함` : "명함이 도착했어요"),
    save: "구글 연락처·주소록에 저장",
    saving: ".vcf 파일이 열리면 ‘연락처 추가’를 누르면 끝이에요.",
    google: "컴퓨터에서 구글 연락처 열기",
    googleHint: "컴퓨터라면 내려받은 .vcf 를 구글 연락처 → 가져오기에서 올리면 됩니다.",
    copy: "기본정보 복사",
    copied: "복사했어요",
    call: "전화",
    mail: "메일",
    more: "명함 자세히 보기",
    imageAlt: (name: string) => `${name}님의 명함 이미지`,
    privacy: "이 링크는 보낸 분이 만든 1인용 링크예요. 열어 본 사람의 정보는 저장하지 않습니다.",
  },
  en: {
    eyebrow: "Card received by text",
    hello: (to: string | null) => (to ? `A card for ${to}` : "You received a card"),
    save: "Save to Google Contacts / phone",
    saving: "When the .vcf opens, tap “Add contact” — that’s it.",
    google: "Open Google Contacts on a computer",
    googleHint: "On a computer, upload the downloaded .vcf via Google Contacts → Import.",
    copy: "Copy details",
    copied: "Copied",
    call: "Call",
    mail: "Email",
    more: "See the full card",
    imageAlt: (name: string) => `${name}'s business card`,
    privacy: "This is a one-person link created by the sender. Nothing about you is stored.",
  },
} as const;

export function SmsCardLanding({ landing, locale = "ko" }: { landing: Landing; locale?: Locale }) {
  const t = T[locale === "en" ? "en" : "ko"];
  const [copied, setCopied] = useState(false);
  const fields = landing.sender.fields ?? [];
  const field = (...types: string[]) => fields.find((f) => types.includes(f.type))?.value ?? null;
  const phone = field("mobile", "phone");
  const email = field("email");
  const plain = [landing.sender.name, [landing.sender.jobTitle, landing.sender.company].filter(Boolean).join(" · "), phone, email].filter(Boolean).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main lang={locale} className="stage-aurora grain min-h-dvh px-5 pb-24 pt-5">
      <div aria-hidden className="marks" />
      <div className="mx-auto max-w-[520px]">
        <header className="flex items-center justify-between">
          <Link href="/"><Logo /></Link>
        </header>

        <div className="mt-7 animate-rise">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1 className="display mt-2 text-[40px] leading-[1.1]">{t.hello(landing.toName)}</h1>
        </div>

        {landing.imageUrl && (
          // 문자에 실려 간 것과 같은 이미지(같은 출처의 짧은 서명 URL). next/image 를 쓰지 않는 이유:
          // 서명 URL 은 만료되므로 최적화 캐시에 남기지 않는다.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={landing.imageUrl}
            alt={t.imageAlt(landing.sender.name)}
            width={1080}
            height={680}
            className="mt-5 w-full rounded-[22px] border border-[var(--line)] shadow-[0_18px_40px_-28px_rgba(27,27,36,.45)]"
          />
        )}

        <div className="mt-6">
          <LivingCard card={landing.sender} locale={locale} showActions={false} />
        </div>

        <section className="mt-6 space-y-2" aria-label={t.save}>
          {/* 한 손 엄지 영역에 가장 큰 버튼 하나 — 저장이 이 화면의 유일한 목적이다 */}
          <a href={landing.vcardPath} download className="btn btn-signal btn-lg w-full" data-testid="sms-card-save">
            <Icon name="download" size={19} /> {t.save}
          </a>
          <p className="text-[13px] text-[var(--fg-mute)]">{t.saving}</p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            {phone && (
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="btn btn-ghost">
                <Icon name="phone" size={18} /> {t.call}
              </a>
            )}
            {email && (
              <a href={`mailto:${email}`} className="btn btn-ghost">
                <Icon name="mail" size={18} /> {t.mail}
              </a>
            )}
            <button type="button" onClick={copy} className="btn btn-ghost" data-testid="sms-card-copy">
              <Icon name="copy" size={18} /> {copied ? t.copied : t.copy}
            </button>
            <Link href={`/p/${encodeURIComponent(landing.sender.slug)}`} className="btn btn-ghost">
              <Icon name="card" size={18} /> {t.more}
            </Link>
          </div>
          <details className="pt-2 text-[13px] text-[var(--fg-mute)]">
            <summary className="cursor-pointer">{t.google}</summary>
            <p className="mt-2">{t.googleHint}</p>
            <a href={GOOGLE_CONTACTS_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex underline">
              contacts.google.com
            </a>
          </details>
        </section>

        <p className="mt-8 text-[12.5px] text-[var(--fg-mute)]">{t.privacy}</p>
      </div>
    </main>
  );
}
