/**
 * P-027 비공개 — `POST /api/v1/me/profile/unpublish`.
 *
 * 멱등하다(이미 비공개여도 같은 응답). 공개 중단은 사용자가 급하게 누르는 동작이라
 * 두 번 눌러 409 를 보는 일이 없어야 한다. 검색 인덱스 제거 통지는 모듈이 같은 트랜잭션에서
 * outbox 에 넣는다 (P-183) — 라우트가 워커를 직접 깨우지 않는다.
 */

import { profile } from "@proplus/api";
import { route } from "@/lib/server";

export const POST = route(async ({ ctx }) => profile.unpublish(ctx));
