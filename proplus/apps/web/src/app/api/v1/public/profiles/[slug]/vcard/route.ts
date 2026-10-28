/**
 * P-035 vCard 내려받기 — `GET /api/v1/public/profiles/{slug}/vcard` (인증 없음).
 *
 * 공개 프로필과 달리 `text/vcard` 원문을 그대로 내려보내므로 `NextResponse` 를 직접 만든다.
 * 담기는 연락처는 모듈이 `publicContact()` 로 판정한 **공개 동의된 값**뿐이다 (기술백서 §6).
 *
 * 파일 이름을 입력 그대로 쓰지 않고 `normalizeSlug()` 를 거친다: Content-Disposition 은 헤더이고,
 * 경로 파라미터에 줄바꿈·따옴표가 섞이면 헤더 분리·이름 위조가 된다. 정규화 결과는 `[a-z0-9-]` 뿐이다.
 */

import { profile } from "@proplus/api";
import { normalizeSlug } from "@proplus/domain";
import { NextResponse } from "next/server";
import { route } from "@/lib/server";

export const GET = route<{ slug: string }>(
  async ({ params, ctx }) => {
    // P-189: 공개·무인증 경로. 모듈이 ip 버킷으로 한도를 소비한다.
    const vcard = await profile.vcardFor(params.slug, { ip: ctx.ip });
    // 여기까지 왔으면 slug 는 존재하는 발행 프로필이다(아니면 모듈이 404 를 던졌다).
    const name = normalizeSlug(params.slug) || "contact";

    return new NextResponse(vcard, {
      status: 200,
      headers: {
        // charset 을 명시해야 한글 이름이 수신 측 주소록에서 깨지지 않는다.
        "content-type": "text/vcard; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.vcf"`,
      },
    });
  },
  { auth: false },
);
