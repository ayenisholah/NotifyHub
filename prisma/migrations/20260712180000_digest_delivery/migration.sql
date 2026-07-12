ALTER TABLE "deliveries" ADD COLUMN "digest_batch_id" UUID;

CREATE UNIQUE INDEX "deliveries_digest_batch_id_key" ON "deliveries"("digest_batch_id");

ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_digest_batch_id_fkey"
FOREIGN KEY ("digest_batch_id") REFERENCES "digest_batches"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
