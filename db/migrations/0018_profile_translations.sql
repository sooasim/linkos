-- F-112 card translations: owner-reviewed en/ja versions of job title, headline, short bio and Offer/Need.
-- Each line keeps its source text so a translation of edited content is never shown. Names, company,
-- e-mail and phone are never translated. Additive only.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
