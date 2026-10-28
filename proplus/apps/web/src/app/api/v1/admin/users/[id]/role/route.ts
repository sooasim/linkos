/**
 * P-172 플랫폼 권한 변경 (최소권한 — 기술백서 §5 · 보안정책 §3).
 *
 * `PUT` 인 이유: 역할은 누적되지 않고 **치환**된다. 같은 값을 두 번 보내도 결과가 같아야 한다.
 *
 * 모듈이 `admin.access` 를 통과한 뒤 `platformRole === 'admin'` 을 한 번 더 요구한다 —
 * `acl.ts` 의 `admin.access` 는 reviewer 에게도 열려 있어서, 그것만 믿으면 검증자가 스스로를
 * 관리자로 올릴 수 있다. 자기 자신 변경도 모듈이 거부한다(권한 상승 경로 차단).
 *
 * 값 집합은 `users.platform_role` 과 domain 의 `PlatformRole` 과 같다. 도메인이 const 배열로
 * 내보내지 않아 여기서 리터럴로 적는다 — 세 값이 어긋나면 모듈의 `role_invalid` 가 잡는다.
 */

import { admin } from "@proplus/api";
import { z } from "zod";
import { parse, route } from "@/lib/server";

const Body = z.object({ role: z.enum(["none", "reviewer", "admin"]) });

export const PUT = route<{ id: string }>(async ({ ctx, params, body }) =>
  admin.setPlatformRole(ctx, params.id, parse(Body, body).role),
);
