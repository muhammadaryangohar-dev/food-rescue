-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DONOR', 'NGO', 'VOLUNTEER', 'ADMIN');

-- CreateEnum
CREATE TYPE "DonorType" AS ENUM ('RESTAURANT', 'EVENT_ORGANISER', 'HOUSEHOLD');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('RESTAURANT', 'EVENT_ORGANISER', 'NGO');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ListingSource" AS ENUM ('RESTAURANT', 'EVENT', 'HOUSEHOLD');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CollectorType" AS ENUM ('VOLUNTEER', 'NGO');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'CLAIMED', 'PICKED_UP', 'DELIVERED', 'LOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandoverType" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('NO_SHOW', 'QUALITY', 'QUANTITY_MISMATCH', 'NOT_DELIVERED', 'SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'UPHELD', 'DISMISSED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL,
    "donor_type" "DonorType",
    "organisation_id" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrgType" NOT NULL,
    "address" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "daily_capacity" INTEGER,
    "service_radius_km" DOUBLE PRECISION,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "household_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "availability" TEXT,
    "service_area" TEXT,
    "approval_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "no_show_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "volunteer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_categories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "default_safe_hours" INTEGER NOT NULL,

    CONSTRAINT "food_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_items" (
    "id" SERIAL NOT NULL,
    "organisation_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_food_records" (
    "id" SERIAL NOT NULL,
    "food_item_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "planned" INTEGER NOT NULL,
    "forecast_shown" INTEGER,
    "prepared" INTEGER,
    "sold" INTEGER,
    "wasted" INTEGER,
    "waste_reason" TEXT,
    "sold_out" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "daily_food_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" SERIAL NOT NULL,
    "organisation_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "venue" TEXT NOT NULL,
    "expected_guests" INTEGER NOT NULL,
    "servings_per_guest" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" "EventStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_food_plans" (
    "id" SERIAL NOT NULL,
    "event_id" INTEGER NOT NULL,
    "food_item_id" INTEGER NOT NULL,
    "planned_servings" INTEGER NOT NULL,

    CONSTRAINT "event_food_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surplus_listings" (
    "id" SERIAL NOT NULL,
    "source_type" "ListingSource" NOT NULL,
    "organisation_id" INTEGER,
    "household_id" INTEGER,
    "event_id" INTEGER,
    "created_by_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "confirmed_quantity" INTEGER NOT NULL,
    "prepared_at" TIMESTAMP(3) NOT NULL,
    "safe_until" TIMESTAMP(3) NOT NULL,
    "collection_deadline" TIMESTAMP(3) NOT NULL,
    "address" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "handling_notes" TEXT,
    "dietary_info" TEXT,
    "safety_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "status" "ListingStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surplus_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ngo_requests" (
    "id" SERIAL NOT NULL,
    "ngo_id" INTEGER NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "requested_quantity" INTEGER NOT NULL,
    "required_by" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "reallocation_pending" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ngo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_decisions" (
    "id" SERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "request_id" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "rejection_reason" TEXT,
    "score" DOUBLE PRECISION,
    "score_breakdown" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" SERIAL NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "request_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lost_quantity" INTEGER NOT NULL DEFAULT 0,
    "status" "AllocationStatus" NOT NULL DEFAULT 'PROPOSED',
    "score" DOUBLE PRECISION,
    "score_breakdown" JSONB,
    "explanation" TEXT,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response_deadline" TIMESTAMP(3) NOT NULL,
    "pickup_deadline" TIMESTAMP(3),
    "decision_reason" TEXT,
    "reallocation_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rescue_tasks" (
    "id" SERIAL NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "collector_type" "CollectorType" NOT NULL,
    "volunteer_id" INTEGER,
    "pickup_otp_hash" TEXT NOT NULL,
    "delivery_otp_hash" TEXT NOT NULL,
    "otp_nonce" TEXT NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "otp_expires_at" TIMESTAMP(3) NOT NULL,
    "claim_deadline" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rescue_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_records" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "type" "HandoverType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "recorded_by_id" INTEGER NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" SERIAL NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "type" "ReportType" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "resolved_by_id" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "reason" TEXT,
    "actor_user_id" INTEGER,
    "time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_by_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "organisations_type_verification_status_idx" ON "organisations"("type", "verification_status");

-- CreateIndex
CREATE UNIQUE INDEX "household_profiles_user_id_key" ON "household_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "volunteer_profiles_user_id_key" ON "volunteer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "food_categories_name_key" ON "food_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "food_items_organisation_id_name_key" ON "food_items"("organisation_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "daily_food_records_food_item_id_date_key" ON "daily_food_records"("food_item_id", "date");

-- CreateIndex
CREATE INDEX "events_status_idx" ON "events"("status");

-- CreateIndex
CREATE INDEX "surplus_listings_status_collection_deadline_idx" ON "surplus_listings"("status", "collection_deadline");

-- CreateIndex
CREATE INDEX "surplus_listings_status_safe_until_idx" ON "surplus_listings"("status", "safe_until");

-- CreateIndex
CREATE INDEX "ngo_requests_status_required_by_idx" ON "ngo_requests"("status", "required_by");

-- CreateIndex
CREATE INDEX "match_decisions_run_id_idx" ON "match_decisions"("run_id");

-- CreateIndex
CREATE INDEX "match_decisions_request_id_idx" ON "match_decisions"("request_id");

-- CreateIndex
CREATE INDEX "allocations_status_response_deadline_idx" ON "allocations"("status", "response_deadline");

-- CreateIndex
CREATE INDEX "allocations_status_pickup_deadline_idx" ON "allocations"("status", "pickup_deadline");

-- CreateIndex
CREATE INDEX "allocations_listing_id_status_idx" ON "allocations"("listing_id", "status");

-- CreateIndex
CREATE INDEX "allocations_request_id_status_idx" ON "allocations"("request_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rescue_tasks_allocation_id_key" ON "rescue_tasks"("allocation_id");

-- CreateIndex
CREATE INDEX "rescue_tasks_status_claim_deadline_idx" ON "rescue_tasks"("status", "claim_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "handover_records_task_id_type_key" ON "handover_records"("task_id", "type");

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status");

-- CreateIndex
CREATE INDEX "status_history_entity_entity_id_idx" ON "status_history"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_profiles" ADD CONSTRAINT "household_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "food_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_food_records" ADD CONSTRAINT "daily_food_records_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_food_plans" ADD CONSTRAINT "event_food_plans_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_food_plans" ADD CONSTRAINT "event_food_plans_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surplus_listings" ADD CONSTRAINT "surplus_listings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surplus_listings" ADD CONSTRAINT "surplus_listings_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "household_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surplus_listings" ADD CONSTRAINT "surplus_listings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surplus_listings" ADD CONSTRAINT "surplus_listings_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "food_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ngo_requests" ADD CONSTRAINT "ngo_requests_ngo_id_fkey" FOREIGN KEY ("ngo_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ngo_requests" ADD CONSTRAINT "ngo_requests_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "food_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "surplus_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ngo_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "surplus_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ngo_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rescue_tasks" ADD CONSTRAINT "rescue_tasks_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rescue_tasks" ADD CONSTRAINT "rescue_tasks_volunteer_id_fkey" FOREIGN KEY ("volunteer_id") REFERENCES "volunteer_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "rescue_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_config" ADD CONSTRAINT "system_config_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written CHECK constraints (proposal NFR4). Prisma cannot express
-- these in schema.prisma, so they live in the migration SQL.
-- =====================================================================

-- Quantities can never be negative / zero where it makes no sense
ALTER TABLE "surplus_listings"  ADD CONSTRAINT "chk_listing_qty_positive"   CHECK ("confirmed_quantity" > 0);
ALTER TABLE "ngo_requests"      ADD CONSTRAINT "chk_request_qty_positive"   CHECK ("requested_quantity" > 0);
ALTER TABLE "allocations"       ADD CONSTRAINT "chk_alloc_qty_positive"     CHECK ("quantity" > 0);
ALTER TABLE "allocations"       ADD CONSTRAINT "chk_alloc_lost_range"       CHECK ("lost_quantity" >= 0 AND "lost_quantity" <= "quantity");
ALTER TABLE "handover_records"  ADD CONSTRAINT "chk_handover_qty_nonneg"    CHECK ("quantity" >= 0);
ALTER TABLE "rescue_tasks"      ADD CONSTRAINT "chk_task_attempts_nonneg"   CHECK ("failed_attempts" >= 0);
ALTER TABLE "organisations"     ADD CONSTRAINT "chk_org_capacity_nonneg"    CHECK ("daily_capacity" IS NULL OR "daily_capacity" >= 0);
ALTER TABLE "organisations"     ADD CONSTRAINT "chk_org_radius_nonneg"      CHECK ("service_radius_km" IS NULL OR "service_radius_km" >= 0);
ALTER TABLE "daily_food_records" ADD CONSTRAINT "chk_food_record_nonneg"    CHECK ("planned" >= 0 AND COALESCE("prepared",0) >= 0 AND COALESCE("sold",0) >= 0 AND COALESCE("wasted",0) >= 0);
ALTER TABLE "events"            ADD CONSTRAINT "chk_event_guests_nonneg"    CHECK ("expected_guests" >= 0 AND "servings_per_guest" >= 0);
ALTER TABLE "event_food_plans"  ADD CONSTRAINT "chk_event_plan_nonneg"      CHECK ("planned_servings" >= 0);

-- Exactly one donor source on a listing, and it must match source_type
ALTER TABLE "surplus_listings" ADD CONSTRAINT "chk_listing_one_source" CHECK (
  num_nonnulls("organisation_id", "household_id", "event_id") = 1
  AND (
    ("source_type" = 'RESTAURANT' AND "organisation_id" IS NOT NULL) OR
    ("source_type" = 'HOUSEHOLD'  AND "household_id"    IS NOT NULL) OR
    ("source_type" = 'EVENT'      AND "event_id"        IS NOT NULL)
  )
);

-- Collection deadline can never be later than the food's safe-until time
ALTER TABLE "surplus_listings" ADD CONSTRAINT "chk_listing_deadline" CHECK ("collection_deadline" <= "safe_until");

-- A volunteer task must name its volunteer once claimed
ALTER TABLE "rescue_tasks" ADD CONSTRAINT "chk_task_claimed_has_volunteer" CHECK (
  "collector_type" = 'NGO' OR "status" IN ('OPEN', 'CANCELLED', 'LOCKED') OR "volunteer_id" IS NOT NULL
);
