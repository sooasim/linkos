import { capture } from "@linkos/api";
import { uploadRoute } from "@/lib/upload";

// 서버 OCR 폴백 — 기기 OCR 이 글자를 못 읽었을 때만, 사용자가 `?consent=1` 로 명시 동의한 경우에 쓴다.
// 사진은 검사·재인코딩 후 호스팅 OCR 로 보내고 저장하지 않는다. 구조화는 서버의 같은 파서가 한다.
export const POST = uploadRoute(
  async ({ ctx, bytes, search }) =>
    capture.captureFromImage(ctx, bytes, {
      consent: search.get("consent") === "1",
      side: search.get("side") === "back" ? "back" : "front",
      kind: search.get("kind") === "badge" ? "badge" : "card",
    }),
  { maxBytes: 8 * 1024 * 1024, idempotencyScope: "capture-ocr" },
);
