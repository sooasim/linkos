import { netintel } from "@linkos/api";
import { parse, route } from "@/lib/server";

// 소속 종료. 현재 소속이 여러 개면 역할 카테고리(masked 라벨의 입력)가 흔들린다.
export const PATCH = route<{ roleId: string }>(async ({ ctx, params, body }) => netintel.endRole(ctx, params.roleId, parse(netintel.endRoleInput, body)));
