// P-100/P-101: 비회원 상담 요청 (데이터모델 §4 — `POST /public/profiles/{slug}/leads`).
//
// **인증 없이 동작한다** (`auth: false`). 공개 프로필을 보던 사람이 로그인 화면을 먼저 만나면 상담이 끊긴다.
// 그래도 쓰기이므로 `route()` 의 origin 검사(CSRF)와 rate limit(모듈의 `lead.create` 버킷)은 그대로 걸린다.
//
// 입력 상한을 모듈의 `sanitizeText()` 길이와 **같게** 맞춘 이유: 더 길게 허용하면 초과분이 조용히 잘려
// 사용자는 보낸 줄 알고 우리는 받지 못한다. 길이를 넘으면 400 으로 알려 주는 쪽이 맞다.

import { lead, notFound } from "@proplus/api";
import { CONSENT_PURPOSES, validateSlug } from "@proplus/domain";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/**
 * N-11 / P-101: 동의는 **목적별로 한 건씩** 온다. `service` 필수 · `marketing` 선택 판정은
 * 도메인의 `validateLeadConsents()` 가 하고(모듈이 호출한다), 여기서는 형식만 본다.
 */
const consentInput = z.strictObject({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
  policyVersion: z.string().min(1).max(40),
});

const createInput = z.strictObject({
  contactName: z.string().min(1).max(80),
  contactKind: z.enum(["email", "phone"]),
  // 이 값만 암호화되어 저장되고 응답·로그에는 마스킹만 나간다 (P-102).
  contact: z.string().min(3).max(200),
  purpose: z.string().max(200).nullish(),
  message: z.string().max(2000).nullish(),
  offerId: z.uuid().nullish(),
  // 모듈은 받은 동의를 한 건씩 INSERT 한다. 개수를 목적 수로 제한하고 중복을 거부하는 이유:
  // 공개 엔드포인트가 한 요청으로 임의 개수의 행을 만드는 통로가 되지 않게 하고(스팸 비용),
  // 같은 목적의 동의가 두 행으로 남아 "무엇에 근거해 처리했는가"가 애매해지는 것을 막는다 (보안정책 §3).
  consents: z
    .array(consentInput)
    .min(1)
    .max(CONSENT_PURPOSES.length)
    .refine((xs) => new Set(xs.map((x) => x.purpose)).size === xs.length, {
      message: "같은 목적의 동의를 중복해 보낼 수 없습니다.",
    }),
  // P-134: 허용 키 선별은 모듈(`pickUtm`)이 한다. 여기서는 객체인지만 본다.
  utm: z.record(z.string(), z.unknown()).nullish(),
});

export const POST = route<{ slug: string }>(
  async ({ ctx, params, body }) => {
    // 형식이 틀린 slug 는 존재할 수 없는 프로필이다(프로필은 정규화된 slug 만 저장한다 — modules/profile.ts).
    // DB 조회 전에 끊어야 rate limit 버킷(`slug:ip`)이 쓰레기 slug 로 무한히 갈라지지 않는다 (P-112).
    const verdict = validateSlug(params.slug);
    if (!verdict.ok) throw notFound("profile");

    return lead.createLead(ctx, verdict.slug, parse(createInput, body));
  },
  { auth: false, status: 201 },
);
