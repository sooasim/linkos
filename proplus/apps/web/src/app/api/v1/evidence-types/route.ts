/**
 * P-050 증거 유형 목록.
 *
 * 인증을 요구하지 않는다(`auth: false`): 응답에 개인정보가 없고(유형 코드·라벨·최소 강도·기본 TTL),
 * 공개 프로필의 "이 배지는 무엇을 뜻하는가" 설명 패널(P-069)이 로그인 없이 같은 목록을 읽어야 한다.
 * 유형 목록이 제출 폼과 공개 설명에서 갈라지면 "무엇이 검증되었는가"의 설명이 두 벌이 된다.
 */

import { proof } from "@proplus/api";
import { route } from "@/lib/server";

export const GET = route(async () => ({ types: await proof.listEvidenceTypes() }), { auth: false });
