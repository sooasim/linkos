import { capture } from "@linkos/api";
import { parse, route } from "@/lib/server";

// F-015 서버 OCR 어댑터: 사진 → 글자줄만. 저장하지 않는다.
// 로그인 없이도 쓸 수 있다 — 게스트가 교환 링크에서 명함을 찍는 길이 그렇다(F-055).
// 실제 조이기·크기 검사·과금은 capture.ocrCardImage 안에 있다.
export const POST = route(async ({ ctx, body }) => capture.ocrCardImage(ctx, parse(capture.ocrInput, body)), { auth: false });
