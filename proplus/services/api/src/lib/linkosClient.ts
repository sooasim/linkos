/**
 * PROPLUS → LINKOS HTTP 클라이언트 (docs/05_LINKOS_INTEGRATION.md §2 · ADR-012).
 *
 * ## 왜 전용 클라이언트인가
 *
 * 두 제품 사이를 오가는 것은 **HTTP 계약 3개뿐**이다(05 문서 §4). LINKOS 쪽 패키지를 가져오는 순간
 * 빌드·타입·배포가 묶이고 "DB 분리"가 말로만 남는다 — `test/architecture.test.ts` 가 그 import 를
 * 구조적으로 금지한다. 그래서 **요청 본문의 모양만** LINKOS 의 `contactInput` 스키마와 맞추고,
 * 코드 결합은 만들지 않는다. 모양이 어긋나면 LINKOS 가 400 을 주고, 그건 재시도해도 낫지 않는
 * 실패이므로 아래 분류에서 `retriable: false` 로 떨어진다(= 조용히 멈춘다).
 *
 * ## 왜 env 가 비면 꺼지는가
 *
 * 연동은 부가 기능이고 PROPLUS 핵심(검증·공개 프로필·상담)은 LINKOS 없이 동작해야 한다(05 문서 §5).
 * 그래서 설정이 없으면 예외를 던지지 않고 "설정되지 않음"을 돌려준다 — `lib/mail.ts` 와 같은 태도다.
 */

import { log } from "./log";

/** LINKOS 가 공개한 외부 리드 수신 엔드포인트. scope `leads:write` 가 필요하다 (05 문서 §2). */
const LEADS_PATH = "/api/v1/ext/leads";

/**
 * 10초. 이 호출은 outbox 워커가 하므로 사용자를 기다리게 하지는 않지만, 응답 없는 소켓을 붙잡으면
 * 워커 한 틱이 거기서 멈춘다. 끊고 재시도하는 쪽이 낫다.
 */
const TIMEOUT_MS = 10_000;

/** 필드별 출처·신뢰도. LINKOS 는 OCR 추정값과 본인 입력값을 이 값으로 구분한다 (05 문서 §2). */
export interface LinkosProvenanceEntry {
  source: string;
  confidence?: number;
}

/** LINKOS `contactInput.encounter` 와 같은 모양. `note` 상한 2000자. */
export interface LinkosEncounterInput {
  placeLabel?: string;
  note?: string;
  eventId?: string;
  occurredAt?: string;
}

/**
 * LINKOS `contactInput` zod 스키마와 **같은 모양**이다
 * (출처: LINKOS `services/api/src/modules/relationship.ts` 의 `contactInput`).
 *
 * 타입을 손으로 다시 적은 이유는 이 파일 상단에 적었다 — 코드 결합을 만들지 않으려는 것이다.
 * LINKOS 가 스키마를 바꾸면 이 인터페이스도 같이 고쳐야 하고, 그 사실을 잊으면 400 으로 드러난다.
 */
export interface LinkosContactInput {
  fullName: string;
  company?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  /** 외부 유입에 맞는 enum 값은 `import` 뿐이다 (05 문서 §2 매핑표). */
  source?: "manual" | "scan" | "exchange" | "import" | "event" | "claim" | "google";
  provenance?: Record<string, LinkosProvenanceEntry>;
  businessCardId?: string | null;
  encounter?: LinkosEncounterInput;
  tags?: string[];
  version?: number;
}

/**
 * `retriable` 이 이 타입의 핵심이다.
 *
 * - **5xx·네트워크·타임아웃 → `retriable: true`.** 상대가 일시적으로 못 받은 것이거나 받았는지 모르는
 *   상태다. 다시 보내는 것이 맞고, 중복은 호출부의 `integration_deliveries` 가 막는다(P-184).
 * - **4xx → `retriable: false`.** 키가 폐기됐거나 스코프가 모자라거나 본문 모양이 틀린 것이다.
 *   같은 요청을 다시 보내도 결과가 같다. 그런데 outbox 워커는 실패를 재시도하므로, 이 구분이 없으면
 *   **폐기된 키로 무한 재시도하며 LINKOS 의 레이트리밋만 태운다** — 그러면 정상적인 다른 테넌트의
 *   연동까지 같이 막힌다(05 문서 §2 "실패 처리").
 */
export type LinkosLeadResult =
  | { ok: true; id?: string }
  | { ok: false; retriable: boolean; status: number; error: string };

interface LinkosConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * 끝의 슬래시를 떼는 이유: `LINKOS_BASE_URL=https://linkos.ckp.kr/` 로 들어오면
 * 경로가 `//api/v1/...` 이 되고, 프록시에 따라 404 가 된다. 운영자가 슬래시 하나로 연동을 잃지 않게 한다.
 */
function readConfig(): LinkosConfig | null {
  const baseUrl = (process.env.LINKOS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.LINKOS_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** 이 연동이 서버에 설정되어 있는지. 설정 화면이 스위치를 비활성화할 근거로도 쓴다 (05 문서 §5). */
export function linkosConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * 상담 리드 하나를 LINKOS 연락처로 보낸다.
 *
 * 이 함수는 **멱등성을 책임지지 않는다.** 중복 방지는 `integration_deliveries` 의 UNIQUE 로
 * 호출부가 한다(05 문서 §2 / P-184) — 여기서 `Idempotency-Key` 를 만들면 워커 재시도마다 새 키가
 * 생겨서(리드 id 를 모르므로) 보호가 되지 않고, 보호되는 것처럼 보이는 쪽이 더 나쁘다.
 */
export async function createLinkosLead(input: LinkosContactInput): Promise<LinkosLeadResult> {
  const cfg = readConfig();
  // 설정이 없으면 "보낼 수 없다"가 아니라 "이 연동이 꺼져 있다"다. 재시도 대상이 아니다.
  if (!cfg) return { ok: false, retriable: false, status: 0, error: "not_configured" };

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${LEADS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 네트워크 실패·타임아웃은 "상대가 받았는지 모른다"다. 재시도하고, 중복은 호출부가 막는다.
    const error = e instanceof Error && e.name ? e.name : "network_error";
    log("warn", "linkos.lead_forward_unreachable", { error });
    return { ok: false, retriable: true, status: 0, error };
  }

  if (!res.ok) {
    /**
     * 본문을 읽지 않는다. LINKOS 의 오류 본문에 어떤 값이 실려 올지 이쪽에서 보장할 수 없고,
     * 그걸 로그나 `integration_deliveries.error` 에 그대로 넣으면 보낸 연락처가 되돌아와 저장될 수 있다
     * (N-13 / 보안정책 §5). 재시도 여부를 정하는 데 필요한 것은 status 하나뿐이다.
     */
    const retriable = res.status >= 500;
    log("warn", "linkos.lead_forward_rejected", { status: res.status, retriable });
    return { ok: false, retriable, status: res.status, error: `http_${res.status}` };
  }

  // 성공 응답에서 꺼내는 것은 원격 id 하나다. 나머지 필드는 연락처 사본이므로 들여오지 않는다.
  const remoteId = await readRemoteId(res);
  return remoteId ? { ok: true, id: remoteId } : { ok: true };
}

/**
 * 응답에서 `id` 만 꺼낸다. 형식이 달라도 전달 자체는 성공한 것이므로 실패로 뒤집지 않는다 —
 * `integration_deliveries.remote_id` 가 비는 것은 추적이 조금 불편해지는 일이고,
 * 성공을 실패로 기록하면 같은 리드가 두 번 들어간다.
 */
async function readRemoteId(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const id = (body as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0 && id.length <= 200) return id;
    }
  } catch {
    // 본문이 비었거나 JSON 이 아니다. 2xx 였으므로 전달은 된 것으로 본다.
  }
  return undefined;
}
