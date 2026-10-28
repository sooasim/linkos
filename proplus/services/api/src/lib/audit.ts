// N-6 / N-7 / P-165 감사로그 기록 (모듈명세 M12 · 데이터모델 §1).
//
// 왜 INSERT 만 하는가: `audit_logs` 에는 `BEFORE UPDATE OR DELETE` 트리거가 걸려 있어 수정·삭제가 예외로 거부된다
// (마이그레이션 0001 `audit_logs_append_only`). 즉 여기서 "고치는" 코드는 런타임에 반드시 터진다 — 애초에 만들지 않는다.
//
// 왜 redact 를 통과시키는가: 운영자 조회 기록에 조회 대상의 이메일·전화를 그대로 남기면
// 감사로그가 가장 매력적인 PII 덩어리가 된다 (보안정책 §3 / N-13). payload 에는 식별자와 코드만 남는다.
import { redact } from "@proplus/domain";
import type { Db } from "./db";
import { pool } from "./db";

export interface AuditInput {
  /** 점 표기 이벤트 이름 (`badge.issued`, `evidence.file.downloaded`). 검증 상태 전이는 DB 트리거가 따로 남긴다(N-6). */
  eventType: string;
  actorId?: string | null;
  /** 플랫폼 역할(reviewer/admin) 또는 조직 역할. 사후에 "누가 어떤 자격으로" 했는지 복원하려면 당시 역할이 필요하다. */
  actorRole?: string | null;
  tenantId?: string | null;
  aggregateType: string;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  /** P-165: 운영자가 개인 데이터를 조회할 때의 목적. 목적 없는 조회는 모듈 계층이 거부한다. */
  accessPurpose?: string | null;
  /** P-187: 응답의 correlation_id 와 같은 값. 사용자 문의 한 건을 로그·감사로그에서 같이 찾을 수 있어야 한다. */
  correlationId?: string | null;
}

/**
 * 감사 한 줄을 남긴다. 도메인 쓰기와 같은 트랜잭션에 넣고 싶으면 `db` 에 트랜잭션 client 를 넘긴다
 * (예: 증거 파일 다운로드는 signed URL 발급과 기록이 함께 남거나 함께 없어야 한다).
 */
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
       (event_type, actor_id, actor_role, tenant_id, aggregate_type, aggregate_id, payload_minimized, access_purpose, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.eventType,
      input.actorId ?? null,
      input.actorRole ?? null,
      input.tenantId ?? null,
      input.aggregateType,
      input.aggregateId ?? null,
      JSON.stringify(redact(input.payload ?? {})),
      input.accessPurpose ?? null,
      input.correlationId ?? null,
    ],
  );
}

/** 요청 문맥이 없는 경로(워커 보존기간 삭제 등)에서 풀로 바로 남기는 단축형. */
export async function writeSystemAudit(input: AuditInput): Promise<void> {
  await writeAudit(pool(), input);
}
