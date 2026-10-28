/**
 * P-010 본인 데이터 내보내기 — `GET /api/v1/me/export`.
 *
 * 증거 원본 파일과 리드 연락처 평문이 **빠져 있는 것이 설계**다(모듈 주석: N-5 / N-13).
 * 라우트가 그 둘을 다시 채우는 인자(`?include=evidence` 같은 것)를 받지 않는 이유:
 * 증거 원본 열람은 다운로드마다 감사로그가 남는 경로여야 하고(보안정책 §3), 내보내기는
 * 그보다 마찰이 낮은 경로라 여기에 구멍을 내면 감사 없는 대량 반출이 된다.
 *
 * 내보내기 자체는 모듈이 `audit_logs` 에 남긴다 (CLAUDE.md §5 대량조회).
 */

import { identity } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route(async ({ ctx }) => identity.exportMyData(ctx));
