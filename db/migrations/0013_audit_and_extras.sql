-- 2026-10 audit fixes + extras X-001..X-007 (additive only; original blueprint tables untouched)

-- ---------- audit G-01: match.created event dedupe (F-092 / F-145) ----------
-- Matches are computed on read; this ledger remembers which subject↔candidate pairs were already announced so
-- `match.created` is emitted once per pair (at-least-once via the outbox), never on every page view.
CREATE TABLE IF NOT EXISTS match_announcements (
  subject_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  candidate_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score numeric NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_profile_id, candidate_profile_id)
);

-- ---------- X-003 card view analytics (privacy-preserving daily counters) ----------
-- No viewer identifier of any kind is stored (no IP, no cookie id, no hash): only per-day counters.
ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_opt_out boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS card_view_daily (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- NULL session = the public /p/[slug] page; the sentinel keeps the primary key simple
  exchange_session_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('view','cta','vcard','reply','link_sig','link_bg','link_wallet')),
  count int NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (profile_id, exchange_session_id, day, kind)
);
CREATE INDEX IF NOT EXISTS card_view_daily_day_idx ON card_view_daily(day);

-- ---------- X-005 / X-006 assistant preferences + digests ----------
CREATE TABLE IF NOT EXISTS user_assistant_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prep_brief_lead_min int NOT NULL DEFAULT 30 CHECK (prep_brief_lead_min BETWEEN 0 AND 240), -- 0 = off
  reconnect_digest boolean NOT NULL DEFAULT true,
  reconnect_email boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prep_brief_deliveries (
  candidate_id uuid PRIMARY KEY REFERENCES calendar_candidates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconnect_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);
