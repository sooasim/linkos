-- 0012: F-022/X-008 Living Card design studio — template choice + per-card design options (additive only).
-- template_id     : id from packages/domain/src/cardTemplates.ts (validated in the card module; unknown → 400)
-- template_options: { accent?, monogram?, icon?, fieldIcons?, keywordBadges?, sectionIcons? }
--                   icons are "i:<icon-bank id>", emoji are "e:<single grapheme from the emoji bank>" (validated server-side)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS template_options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_template_id_format;
ALTER TABLE profiles ADD CONSTRAINT profiles_template_id_format CHECK (template_id IS NULL OR template_id ~ '^[a-z][a-z0-9-]{2,40}$');
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_template_options_object;
ALTER TABLE profiles ADD CONSTRAINT profiles_template_options_object CHECK (jsonb_typeof(template_options) = 'object');
