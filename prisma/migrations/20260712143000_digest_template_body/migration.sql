ALTER TABLE "templates"
ADD CONSTRAINT "templates_digest_body_required_check"
CHECK (NOT "digest_enabled" OR "digest_body" IS NOT NULL);
