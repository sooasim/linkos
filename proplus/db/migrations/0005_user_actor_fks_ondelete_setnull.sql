-- 0005: users(id) 를 참조하는 nullable FK 중 ON DELETE 절이 없는 것을 모두 SET NULL 로 맞춘다.
--
-- 왜: 0001 은 여러 actor 참조(verified_by·submitted_by·reviewer_id·resolved_by·assigned_to·
-- changed_by·handled_by 등)를 ON DELETE 절 없이 걸었다. 사용자를 지울 때 그 중 하나라도 참조 행이
-- 남아 있으면 23503 으로 막힌다. 0004 가 profile_versions.created_by 하나를 고쳤더니 다음 블로커
-- (leads.assigned_to)가 또 드러났다 — 하나씩 쫓지 않고 nullable 인 것 전부를 한 번에 맞춘다.
-- 방향은 0003_linkos_integration 의 선택과 같다: 행(이력·감사)은 남기고 actor 참조만 비운다.
--
-- NOT NULL actor FK(org_invites.invited_by·notes.author_id 등)는 일부러 건드리지 않는다 — SET NULL
-- 이 불가능하고, 사용자 삭제 시 그 행을 CASCADE 로 지울지는 데이터 보존·삭제 정책(데이터모델 §7-2,
-- 미결정)이 정할 일이지 이 마이그레이션이 임의로 결정할 것이 아니다(전략 §8).
--
-- confdeltype='a'(NO ACTION) 인 것만 고르므로 0004 가 이미 SET NULL('n') 로 바꾼 것은 건너뛴다.
-- 재실행해도(멱등) 바꿀 대상이 없다 — 한 번 돌면 모두 'n' 이 된다.
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
       AND att.attnotnull = false
       AND cl.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE SET NULL',
                   r.tbl, r.conname, r.col);
  END LOOP;
END $$;
