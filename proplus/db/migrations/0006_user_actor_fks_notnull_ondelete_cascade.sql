-- 0006: users(id) 를 참조하는 NOT NULL actor FK 중 ON DELETE 절이 없는 것을 CASCADE 로 맞춘다.
--
-- 왜: 0005 가 nullable actor FK 를 SET NULL 로 바꿨지만, NOT NULL actor FK(org_invites.invited_by,
-- verification_notes.reviewer_id, appeals.submitted_by, lead_notes.author_id)는 SET NULL 이 불가능해
-- 그대로 남았다. 이들이 사용자 삭제(계정 삭제 P-011·통합테스트 teardown)를 23503 으로 막는다.
-- NOT NULL 이라 남은 선택은 CASCADE 뿐이다: 사용자가 사라지면 그 사용자가 만든 **작업 레코드**
-- (보낸 초대·작성한 검토메모·제출한 이의제기·남긴 리드메모)도 함께 지운다.
--
-- 불변 감사 추적은 영향받지 않는다: audit_logs.actor_id 는 애초에 FK 가 아닌 bare uuid 라
-- (0001 §M12) 사용자가 지워져도 감사 로그 행은 남는다 — 그것이 "누가 했는지"를 보존하는 설계다.
-- 작업 레코드의 보존 기간·익명화 정책(데이터모델 §7-2)은 미결정이며(전략 §8), 여기서 정하는 것은
-- "사용자 삭제가 가능해야 한다"는 하한뿐이다. 더 세밀한 보존이 필요하면 후속 마이그레이션이 조정한다.
--
-- confdeltype='a'(NO ACTION) + NOT NULL 인 것만 고른다. 이미 CASCADE('c')·SET NULL('n') 인 것은
-- 건너뛴다(멱등 — 한 번 돌면 모두 'c' 가 된다).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname, cl.relname AS tbl, att.attname AS col
      FROM pg_constraint con
      JOIN pg_class cl  ON cl.oid  = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND ref.relname = 'users'
       AND con.confdeltype = 'a'
       AND att.attnotnull = true
       AND cl.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE CASCADE',
                   r.tbl, r.conname, r.col);
  END LOOP;
END $$;
