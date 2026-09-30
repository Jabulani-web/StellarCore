-- Issue #167: durable per-source circuit breakers for reviewed live-rate
-- sources, keyed to the reviewed source identity (anchor slug + corridor slug).

-- CreateEnum
CREATE TYPE "source_breaker_state" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

-- CreateTable
CREATE TABLE "source_breakers" (
    "anchor_slug" TEXT NOT NULL,
    "corridor_slug" TEXT NOT NULL,
    "state" "source_breaker_state" NOT NULL DEFAULT 'CLOSED',
    "consecutive_transport_failures" INTEGER NOT NULL DEFAULT 0,
    "consecutive_opens" INTEGER NOT NULL DEFAULT 0,
    "recent_invalid_evidence_failures" INTEGER NOT NULL DEFAULT 0,
    "open_at" TIMESTAMPTZ(6),
    "cooldown_until" TIMESTAMPTZ(6),
    "recovery_probe_token" TEXT,
    "recovery_probe_deadline" TIMESTAMPTZ(6),
    "recovery_probes_active" INTEGER NOT NULL DEFAULT 0,
    "window_start_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failure_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_breakers_pkey" PRIMARY KEY ("anchor_slug","corridor_slug")
);

-- CreateIndex
CREATE INDEX "source_breakers_state_cooldown_until_idx" ON "source_breakers"("state", "cooldown_until");
