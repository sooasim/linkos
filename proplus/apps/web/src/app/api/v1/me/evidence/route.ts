/**
 * P-051 증거 제출 · 내 증거 목록 (데이터모델 §4 `POST /me/evidence` · `GET /me/evidence`).
 *
 * 데이터모델 §4 는 이 경로를 "증거 메타데이터 **및 파일 업로드 세션 생성**"으로 적는다.
 * 그래서 `upload` 가 함께 오면 제출 직후 `proof.createUploadSession()` 결과를 같은 응답에 끼운다 —
 * 클라이언트가 "제출 → 세션 요청" 두 번의 왕복을 하지 않아도 되고, 세션은 상태를 만들지 않는
 * 사전검사이므로(모듈 주석 참조) 제출이 성공한 뒤 덧붙여도 부작용이 없다.
 *
 * 소유권은 입력으로 믿지 않는다 — `subjectId`·`organizationId` 를 받아도 모듈이 DB 로 다시 확인한다.
 * 라우트는 **모양만** 검사한다(전략 §3: 라우트에 비즈니스 분기·권한 계산을 두지 않는다).
 */

import { proof } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

/** `EvidenceSource` (domain types.ts). 도메인이 const 배열로 내보내지 않아 여기서 리터럴로 적는다. */
const SOURCE_TYPES = ["user", "platform", "organization", "third_party"] as const;

/**
 * 업로드 사전검사 입력. **파일명을 받지 않는다** — 모듈이 저장하지 않고(N-13) 세션 판정에도 쓰지 않는다.
 * 확장자 교차검증이 필요한 순간은 바이트가 함께 오는 `POST /me/evidence/{id}/files` 뿐이다.
 */
const UploadMeta = z.object({
  declaredMime: z.string().min(3).max(120),
  byteSize: z.number().int().positive(),
});

const SubmitSchema = z.object({
  subjectType: z.enum(["profile", "organization"]).optional(),
  subjectId: z.uuid().optional(),
  evidenceType: z.string().min(1).max(60),
  issuerId: z.uuid().nullish(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceReference: z.string().max(300).nullish(),
  /** 제출 시점의 범위는 **주장**이다. 확정 범위는 검증자가 approve 에서 넣는다 (보안정책 §4.3). */
  scope: z.string().max(200).nullish(),
  claim: z.record(z.string(), z.unknown()).optional(),
  organizationId: z.uuid().nullish(),
  upload: UploadMeta.optional(),
});

export const GET = route(async ({ ctx }) => ({ items: await proof.listMyEvidence(ctx) }));

export const POST = route(async ({ ctx, body }) => {
  const { upload, ...input } = parse(SubmitSchema, body);
  const created = await proof.submitEvidence(ctx, input);
  if (!upload) return created;
  return { ...created, upload: await proof.createUploadSession(ctx, created.evidenceId, upload) };
}, { status: 201 });
