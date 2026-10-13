import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-017 privacy-filtered 그래프 slice. 숨길 노드는 서버에서 제거되고 브라우저로 내려가지 않는다.
// dim=3 이면 3D 좌표(x3/y3/z)까지 계산한다 — 2D 화면에서 쓰지 않는 좌표를 매번 계산하지 않는다.
export const GET = route(async ({ ctx, req }) => {
  const sp = req.nextUrl.searchParams;
  return netintel.graphSlice(ctx, {
    hops: Number(sp.get("hops") ?? 2),
    maxNodes: Number(sp.get("maxNodes") ?? 300),
    dim: sp.get("dim") === "3" ? 3 : 2,
  });
});
