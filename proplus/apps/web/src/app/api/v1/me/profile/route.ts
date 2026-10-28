/**
 * P-020/P-021/P-029 내 프로필 — `GET`·`POST`·`PATCH /api/v1/me/profile`.
 *
 * (데이터모델 §4 는 `PATCH /me/profile` 만 적지만 생성 경로가 없으면 첫 사용자가 들어올 문이 없다.
 *  그래서 같은 리소스에 `POST`(생성, 201)를 둔다 — 새 경로를 만들지 않는 쪽이 §4 와 덜 어긋난다.)
 *
 * zod 는 **형식과 크기만** 본다. 다듬기(sanitizeText)·길이 잘라내기·금지 표현·slug 정규화는 모듈과 도메인이
 * 한 곳에서 한다: 같은 규칙을 라우트에도 복사하면 두 곳이 어긋나 "저장은 됐는데 공개 화면에서 다른 값"이 된다.
 * 여기 상한은 모듈 상한보다 넉넉한 **방어선**이다(거대한 본문이 sanitize 까지 도달하지 않게).
 */

import { profile } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Write = z.object({
  slug: z.string().max(120).optional(),
  displayName: z.string().max(320).optional(),
  headline: z.string().max(480).nullable().optional(),
  bio: z.string().max(8000).nullable().optional(),
  specialties: z.array(z.string().max(240)).max(50).optional(),
  languages: z.array(z.string().max(160)).max(50).optional(),
  region: z.string().max(240).nullable().optional(),
  // 키 allowlist 는 모듈의 `cleanSettings()` 가 가진다 (P-029). 여기서 목록을 또 적으면
  // 설정 키를 추가할 때마다 두 파일을 고쳐야 하고, 한쪽을 빠뜨리면 조용히 무시된다.
  publicSettings: z.record(z.string(), z.unknown()).optional(),
});

/** 생성에는 주소와 이름이 반드시 필요하다(그 둘이 공개 URL 과 제목을 만든다). */
const Create = Write.extend({
  slug: z.string().max(120),
  displayName: z.string().max(320),
});

export const GET = route(async ({ ctx }) => ({ profile: await profile.getMyProfile(ctx) }));

export const POST = route(
  async ({ ctx, body }) => ({ profile: await profile.createProfile(ctx, parse(Create, body)) }),
  { status: 201 },
);

export const PATCH = route(async ({ ctx, body }) => ({ profile: await profile.updateProfile(ctx, parse(Write, body)) }));
