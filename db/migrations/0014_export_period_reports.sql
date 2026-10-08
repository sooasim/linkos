-- F-125 / UX-023 export period filter + fact-only reports (additive only; original blueprint tables untouched)
-- params = { since?: ISO, until?: ISO } — the period the export was requested for. `kind` additionally takes
-- 'report:meetings' and 'report:relationships' (contacts exports keep 'contacts' / 'contacts:tag:<name>').
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}';
