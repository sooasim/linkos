// P-081: 도메인 TXT 대조. **DNS 조회는 이 라우트가 한다.**
//
// 모듈은 네트워크 I/O 를 하지 않고 조회 결과 배열만 받는다 (`modules/org.ts` confirmDomainVerification 주석:
// 틀리면 안 되는 부분은 네트워크가 아니라 대조 규칙이고, 그건 순수 입력으로 전수 테스트해야 한다).
//
// **조회할 호스트를 요청 본문에서 받지 않는 이유(검증 우회 차단):**
// 본문으로 도메인을 받으면, 관리자가 `bigcorp.com` 을 주장해 두고 자기 소유인 `myown.com` 에 challenge 를
// 게시한 뒤 `myown.com` 을 넘길 수 있다. 모듈은 DB 에 저장된 도메인(`bigcorp.com`)을 검증 완료로 바꾸므로
// 그대로 통과한다. 그래서 조회 대상은 **DB 가 말하는 호스트**(getOrganization 이 돌려주는 pendingTxtRecord)
// 하나뿐이고, 클라이언트는 어떤 호스트를 조회할지 고를 수 없다.

import { Resolver } from "node:dns/promises";
import { conflict, org } from "@proplus/api";
import { z } from "zod";
import { route } from "@/lib/server";

const orgId = z.uuid();

/** 사용자가 버튼을 누르고 기다리는 동기 경로다. resolver 기본값(무제한)은 요청을 매달아 둔다. */
const DNS_TIMEOUT_MS = 4000;

/**
 * "아직 전파되지 않음"에 해당하는 resolver 코드. 레코드가 없는 것은 오류가 아니라 흔한 정상 상태이므로
 * 빈 배열로 넘겨 모듈이 `{ verified: false, expected }` 를 돌려주게 한다 — 사용자는 다시 누르면 된다.
 */
const NOT_PROPAGATED = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

async function lookupTxt(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  try {
    const records = await resolver.resolveTxt(host);
    // 긴 TXT 는 255바이트 조각으로 쪼개져 `string[][]` 로 온다. 안쪽 배열을 이어 붙인 것이 한 레코드다.
    return records.map((chunks) => chunks.join(""));
  } catch (e) {
    const code = (e as { code?: string } | null)?.code ?? "";
    if (NOT_PROPAGATED.has(code)) return [];
    // 503 을 쓰지 않는 이유: 503 은 "우리 서비스가 지금 불가"라는 뜻이고, 여기서 실패한 것은
    // **호출자가 주장한 도메인의 DNS** 다. 현재 상태로는 검증을 진행할 수 없다는 의미의 409 가 맞다.
    throw conflict("dns_lookup_failed", "도메인 DNS 를 조회할 수 없습니다. 네트워크 설정을 확인한 뒤 다시 시도하세요.");
  }
}

export const POST = route<{ id: string }>(async ({ ctx, params }) => {
  const id = orgId.parse(params.id);

  // 어떤 호스트를 조회해야 하는지는 조직 레코드만 안다. 멤버가 아니면 여기서 404 로 끊긴다.
  const current = await org.getOrganization(ctx, id);
  const host = current.pendingTxtRecord?.recordHost ?? null;

  // host 가 없으면 (a) 이미 검증 완료이거나 (b) 검증을 시작하지 않은 것이다. 둘의 구분과 응답은
  // 모듈이 한다(이미 완료 → alreadyVerified, 미시작 → 409). 라우트가 상태를 추측하지 않는다.
  const records = host ? await lookupTxt(host) : [];
  return org.confirmDomainVerification(ctx, id, records);
});
