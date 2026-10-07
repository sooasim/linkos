-- 0011: relationships_owner_strength_idx (added in 0004) is not used by any query, and with stale planner
-- statistics (right after a bulk import) Postgres picked it for the per-contact relationship probe in
-- listContacts, turning one unique-index lookup into an owner-wide scan per row (5,300 × 5,000 rows, ~10s p95).
-- The unique (owner_user_id, contact_id) index serves every relationship lookup; strength ranking reads
-- the owner's relationships through it as well.
DROP INDEX IF EXISTS relationships_owner_strength_idx;
