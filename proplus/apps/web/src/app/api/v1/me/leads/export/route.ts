// P-109: 리드 내보내기(CSV). 대량조회이므로 모듈이 접근 사유와 함께 감사로그를 남긴다 (CLAUDE.md §5).
//
// **왜 GET 이 아니라 POST 인가:** 이 응답은 고객 PII 묶음이다. GET 으로 두면 필터와 접근 사유가 URL 에 실려
// 액세스 로그·Referer·브라우저 이력에 "고객 연락처 전체 내보내기" 주소가 남고, 그 주소는 다시 쓸 수 있다.
// POST 면 `route()` 의 origin 검사(CSRF)도 함께 걸린다 — 읽기 메서드는 그 검사를 지나지 않는다.
//
// 기본값은 마스킹이다. 원문 연락처는 `includeContact` + `accessPurpose` 가 둘 다 있을 때만 포함되고
// 그 사유가 `audit_logs.access_purpose` 에 남는다 (P-165).

import { lead } from "@proplus/api";
import { LEAD_STAGES, LEAD_STAGE_LABEL_KO } from "@proplus/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parse, route } from "@/lib/server";

type ExportRow = Awaited<ReturnType<typeof lead.exportLeads>>["rows"][number];

/** P-134 에서 저장을 허용한 UTM 키와 같은 목록. 열을 고정해야 매번 같은 모양의 파일이 나온다. */
const UTM_COLUMNS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

/** 엑셀은 BOM 이 없는 UTF-8 CSV 를 지역 코드페이지로 읽어 한글을 깨뜨린다. */
const BOM = "\uFEFF";

const exportInput = z.strictObject({
  profileId: z.uuid().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  assignedTo: z.uuid().optional(),
  organizationId: z.uuid().optional(),
  from: z.string().min(4).max(40).optional(),
  to: z.string().min(4).max(40).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  includeContact: z.boolean().optional(),
  // 사유 필수 판정은 모듈이 한다(`includeContact` 와 짝이다). 여기서는 "ㅇ" 한 글자 사유를 막는다.
  accessPurpose: z.string().min(2).max(200).optional(),
});

/**
 * CSV 한 칸. 항상 따옴표로 감싸서 쉼표·줄바꿈을 신경 쓰지 않게 한다.
 *
 * `=`·`+`·`-`·`@` 로 시작하는 값 앞에 작은따옴표를 붙이는 이유(CSV 수식 주입):
 * 이 파일의 내용 중 성함·문의목적은 **비회원이 공개 폼에 입력한 값**이고, 엑셀은 그런 셀을 수식으로 실행한다.
 * 받는 사람의 PC 에서 실행되는 코드가 되지 않게 문자열로 고정한다 (보안정책 §2 — 입력을 신뢰하지 않는다).
 */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(rows: readonly ExportRow[], includeContact: boolean): string {
  const header = [
    "리드ID",
    "접수일시",
    "단계",
    "성함",
    "연락처종류",
    "연락처(마스킹)",
    ...(includeContact ? ["연락처(원문)"] : []),
    "문의목적",
    "담당자ID",
    "첫응답일시",
    "프로필ID",
    "조직ID",
    "상품ID",
    ...UTM_COLUMNS,
  ];

  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const cells = [
      row.id,
      row.createdAt,
      // 색이 아니라 텍스트로 상태를 말한다는 규칙(브랜드 §7)은 내보낸 파일에서도 같다.
      LEAD_STAGE_LABEL_KO[row.stage],
      row.contactName,
      row.contactKind,
      row.contactMasked,
      ...(includeContact ? [row.contact ?? ""] : []),
      row.purpose ?? "",
      row.assignedTo ?? "",
      row.firstResponseAt ?? "",
      row.profileId,
      row.organizationId ?? "",
      row.offerId ?? "",
      ...UTM_COLUMNS.map((key) => row.utm[key] ?? ""),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  // 엑셀·구형 파서를 위해 CRLF 로 끝낸다 (RFC 4180).
  return `${lines.join("\r\n")}\r\n`;
}

export const POST = route(async ({ ctx, body }) => {
  const result = await lead.exportLeads(ctx, parse(exportInput, body));
  const filename = `proplus-leads-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(BOM + toCsv(result.rows, result.includedContacts), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // 파일명은 ASCII 만 쓴다 — 한글 파일명은 제공 방식(filename*)이 브라우저마다 달라 깨지기 쉽다.
      "content-disposition": `attachment; filename="${filename}"`,
      // 고객 PII 묶음이다. 공유 캐시·디스크 캐시에 남지 않게 한다 (보안정책 §3).
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-export-count": String(result.count),
    },
  });
});
