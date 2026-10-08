-- Additive only. Whitepaper gap closure (backend round 2):
-- §3.1 exchange state machine history + SYNCED · F-161 guest consent ledger · §9 Encounter append-only guard ·
-- exportMyData as a queued job (04_OPENAPI 202 Queued).

-- ---------- F-037~F-064 §3.1 exchange state machine ----------
-- Every transition the server takes is appended here ({from,to,at}); `synced_at` records a successful external
-- (Google/CRM) sync of a contact produced by the exchange while the session cannot enter SYNCED yet (CLAIM_PENDING).
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS state_history jsonb NOT NULL DEFAULT '[]';
ALTER TABLE exchange_sessions ADD COLUMN IF NOT EXISTS synced_at timestamptz;

-- ---------- F-161 consent ledger: guest exchange consent at reply time ----------
-- A guest has no user id yet: the record is keyed by the guest claim (and session) and linked to the user on claim.
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS guest_claim_id uuid REFERENCES guest_claims(id) ON DELETE SET NULL;
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS exchange_session_id uuid REFERENCES exchange_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS consent_records_guest_claim_idx ON consent_records(guest_claim_id) WHERE guest_claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consent_records_subject_idx ON consent_records(subject_user_id, consent_type, created_at DESC);

-- ---------- F-168 exportMyData: queued job processed by the worker ----------
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS object_id uuid REFERENCES stored_objects(id) ON DELETE SET NULL;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE INDEX IF NOT EXISTS export_jobs_queued_idx ON export_jobs(created_at) WHERE status = 'queued';

-- ---------- F-067 §9 Encounter is append-only ----------
-- An Encounter is a historical fact ("we met here, then"). Its content can never be rewritten:
--  * UPDATE of occurred_at / place_label / note / source / contact_id / event_id / context is refused;
--    owner_user_id may change (F-132 lead reassignment moves the timeline to the new 담당자) and
--    exchange_session_id may be cleared by its ON DELETE SET NULL.
--  * contact_id may only be re-pointed by a duplicate merge, which opts in with SET LOCAL linkos.allow_encounter_relink='on'.
--  * DELETE (incl. cascades from users/contacts) only on privacy deletion / retention purge paths, which opt in with
--    SET LOCAL linkos.allow_encounter_delete='on'.
--  * linkos.encounter_maintenance='on' is for operator backfills/tests only; application code never sets it.
CREATE OR REPLACE FUNCTION linkos_encounters_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('linkos.encounter_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('linkos.allow_encounter_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'encounters are append-only: delete is only allowed on account deletion / retention paths'
      USING ERRCODE = 'P0001', HINT = 'encounter_append_only';
  END IF;
  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.place_label IS DISTINCT FROM OLD.place_label
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.context IS DISTINCT FROM OLD.context THEN
    RAISE EXCEPTION 'encounters are append-only: content columns cannot be updated'
      USING ERRCODE = 'P0001', HINT = 'encounter_append_only';
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND current_setting('linkos.allow_encounter_relink', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'encounters are append-only: contact_id can only change through a duplicate merge'
      USING ERRCODE = 'P0001', HINT = 'encounter_append_only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS encounters_append_only ON encounters;
CREATE TRIGGER encounters_append_only BEFORE UPDATE OR DELETE ON encounters
  FOR EACH ROW EXECUTE FUNCTION linkos_encounters_append_only();
