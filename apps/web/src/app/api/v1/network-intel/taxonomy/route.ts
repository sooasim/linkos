import { netintel } from "@linkos/api";
import { route } from "@/lib/server";

// N-011 산업/지역/역할 분류 — 검색 chip 과 ICP 편집의 선택지
export const GET = route(async () => netintel.taxonomy());
