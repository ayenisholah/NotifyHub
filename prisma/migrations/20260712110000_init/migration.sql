CREATE TYPE "Channel" AS ENUM ('EMAIL', 'SMS', 'IN_APP');
CREATE TYPE "NotificationStatus" AS ENUM ('ACCEPTED', 'ROUTED', 'NO_OP');
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'RETRYING', 'FAILED', 'DLQ', 'SCHEDULED');
CREATE TYPE "DigestBatchStatus" AS ENUM ('OPEN', 'FLUSHED');

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preferences" (
    "user_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "preferences_pkey" PRIMARY KEY ("user_id", "channel", "category")
);

CREATE TABLE "quiet_hours" (
    "user_id" TEXT NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    CONSTRAINT "quiet_hours_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "quiet_hours_start_minute_check" CHECK ("start_minute" BETWEEN 0 AND 1439),
    CONSTRAINT "quiet_hours_end_minute_check" CHECK ("end_minute" BETWEEN 0 AND 1439)
);

CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "body_html" TEXT,
    "digest_body" TEXT,
    "digest_enabled" BOOLEAN NOT NULL DEFAULT false,
    "digest_window_minutes" INTEGER NOT NULL DEFAULT 10,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "templates_digest_window_minutes_check" CHECK ("digest_window_minutes" > 0)
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'ACCEPTED',
    "no_op_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "scheduled_for" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "deliveries_attempts_check" CHECK ("attempts" >= 0)
);

CREATE TABLE "delivery_events" (
    "id" BIGSERIAL NOT NULL,
    "delivery_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digest_batches" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "window_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "DigestBatchStatus" NOT NULL DEFAULT 'OPEN',
    CONSTRAINT "digest_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digest_items" (
    "batch_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "digest_items_pkey" PRIMARY KEY ("batch_id", "notification_id")
);

CREATE TABLE "inbox_messages" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "notification_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "templates_event_channel_locale_key" ON "templates"("event", "channel", "locale");
CREATE UNIQUE INDEX "notifications_idempotency_key_key" ON "notifications"("idempotency_key");
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at" DESC);
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);
CREATE INDEX "deliveries_notification_id_idx" ON "deliveries"("notification_id");
CREATE INDEX "deliveries_status_scheduled_for_idx" ON "deliveries"("status", "scheduled_for");
CREATE INDEX "delivery_events_delivery_id_created_at_idx" ON "delivery_events"("delivery_id", "created_at");
CREATE INDEX "digest_batches_status_window_ends_at_idx" ON "digest_batches"("status", "window_ends_at");
CREATE UNIQUE INDEX "digest_batches_one_open_key" ON "digest_batches"("user_id", "event", "channel") WHERE "status" = 'OPEN';
CREATE INDEX "digest_items_notification_id_idx" ON "digest_items"("notification_id");
CREATE UNIQUE INDEX "inbox_messages_notification_id_key" ON "inbox_messages"("notification_id");
CREATE INDEX "inbox_messages_user_id_created_at_idx" ON "inbox_messages"("user_id", "created_at" DESC);
CREATE INDEX "inbox_messages_user_unread_idx" ON "inbox_messages"("user_id", "created_at" DESC) WHERE "read_at" IS NULL;

ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiet_hours" ADD CONSTRAINT "quiet_hours_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digest_batches" ADD CONSTRAINT "digest_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "digest_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
