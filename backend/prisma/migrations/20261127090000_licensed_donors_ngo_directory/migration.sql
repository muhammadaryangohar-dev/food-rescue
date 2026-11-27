-- Scope change (FoodRescue Scope Change Note, 27 Nov 2026):
--   * Only LICENSED food businesses donate: restaurants, and marquees / caterers.
--     EVENT_ORGANISER is renamed MARQUEE_CATERER.
--   * Households no longer donate. They use the public NGO directory, which an NGO
--     appears in only if it opts in (show_in_directory), keeping NFR8.
--   * A listing always belongs to the donor business; event_id is optional on top.
--   * NGOs get a type (orphanage, shelter, ...) and a beneficiaries count.
--
-- Safe on a database that already holds data: household listings and accounts are removed
-- first, and existing donor businesses get a placeholder licence and go back to PENDING so an
-- admin re-verifies them with a real licence.

-- ---------------------------------------------------------------- 1. remove household data

CREATE TEMP TABLE _hh_users    ON COMMIT DROP AS SELECT "id" FROM "users" WHERE "donor_type" = 'HOUSEHOLD';
CREATE TEMP TABLE _hh_listings ON COMMIT DROP AS SELECT "id" FROM "surplus_listings" WHERE "source_type" = 'HOUSEHOLD';
CREATE TEMP TABLE _hh_allocs   ON COMMIT DROP AS SELECT "id" FROM "allocations" WHERE "listing_id" IN (SELECT "id" FROM _hh_listings);
CREATE TEMP TABLE _hh_tasks    ON COMMIT DROP AS SELECT "id" FROM "rescue_tasks" WHERE "allocation_id" IN (SELECT "id" FROM _hh_allocs);

DELETE FROM "handover_records" WHERE "task_id" IN (SELECT "id" FROM _hh_tasks) OR "recorded_by_id" IN (SELECT "id" FROM _hh_users);
DELETE FROM "rescue_tasks"     WHERE "id" IN (SELECT "id" FROM _hh_tasks);
DELETE FROM "reports"          WHERE "allocation_id" IN (SELECT "id" FROM _hh_allocs) OR "reporter_id" IN (SELECT "id" FROM _hh_users);
DELETE FROM "status_history"   WHERE ("entity" = 'TASK'       AND "entity_id" IN (SELECT "id" FROM _hh_tasks))
                                  OR ("entity" = 'ALLOCATION' AND "entity_id" IN (SELECT "id" FROM _hh_allocs))
                                  OR ("entity" = 'LISTING'    AND "entity_id" IN (SELECT "id" FROM _hh_listings));
DELETE FROM "allocations"      WHERE "id" IN (SELECT "id" FROM _hh_allocs);
DELETE FROM "surplus_listings" WHERE "id" IN (SELECT "id" FROM _hh_listings); -- match_decisions cascade

UPDATE "status_history" SET "actor_user_id" = NULL WHERE "actor_user_id" IN (SELECT "id" FROM _hh_users);
UPDATE "reports"        SET "resolved_by_id" = NULL WHERE "resolved_by_id" IN (SELECT "id" FROM _hh_users);
UPDATE "system_config"  SET "updated_by_id" = NULL WHERE "updated_by_id" IN (SELECT "id" FROM _hh_users);
DELETE FROM "users" WHERE "id" IN (SELECT "id" FROM _hh_users); -- household_profiles, notifications cascade

-- ---------------------------------------------------------------- 2. structure

-- The old CHECK mentions household_id and 'HOUSEHOLD'; drop it before changing them
ALTER TABLE "surplus_listings" DROP CONSTRAINT "chk_listing_one_source";

ALTER TABLE "surplus_listings" DROP CONSTRAINT "surplus_listings_household_id_fkey";
ALTER TABLE "surplus_listings" DROP COLUMN "household_id";
ALTER TABLE "household_profiles" DROP CONSTRAINT "household_profiles_user_id_fkey";
DROP TABLE "household_profiles";

-- Donor type: drop HOUSEHOLD, rename EVENT_ORGANISER -> MARQUEE_CATERER
CREATE TYPE "DonorType_new" AS ENUM ('RESTAURANT', 'MARQUEE_CATERER');
ALTER TABLE "users" ALTER COLUMN "donor_type" TYPE "DonorType_new" USING (
  CASE "donor_type"::text WHEN 'EVENT_ORGANISER' THEN 'MARQUEE_CATERER' ELSE "donor_type"::text END
)::"DonorType_new";
ALTER TYPE "DonorType" RENAME TO "DonorType_old";
ALTER TYPE "DonorType_new" RENAME TO "DonorType";
DROP TYPE "DonorType_old";

ALTER TYPE "OrgType" RENAME VALUE 'EVENT_ORGANISER' TO 'MARQUEE_CATERER';

CREATE TYPE "ListingSource_new" AS ENUM ('RESTAURANT', 'EVENT');
ALTER TABLE "surplus_listings" ALTER COLUMN "source_type" TYPE "ListingSource_new" USING ("source_type"::text::"ListingSource_new");
ALTER TYPE "ListingSource" RENAME TO "ListingSource_old";
ALTER TYPE "ListingSource_new" RENAME TO "ListingSource";
DROP TYPE "ListingSource_old";

CREATE TYPE "NgoType" AS ENUM ('FOOD_KITCHEN', 'ORPHANAGE', 'OLD_AGE_HOME', 'SHELTER', 'OTHER');

ALTER TABLE "organisations"
  ADD COLUMN "ngo_type"           "NgoType",
  ADD COLUMN "beneficiaries"      INTEGER,
  ADD COLUMN "licence_number"     TEXT,
  ADD COLUMN "licence_authority"  TEXT,
  ADD COLUMN "licence_expires_on" DATE,
  ADD COLUMN "contact_phone"      TEXT,
  ADD COLUMN "contact_email"      TEXT,
  ADD COLUMN "description"        TEXT,
  ADD COLUMN "show_in_directory"  BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "organisations_licence_authority_licence_number_key" ON "organisations"("licence_authority", "licence_number");

-- A listing always belongs to its donor business (event listings used to leave it empty)
UPDATE "surplus_listings" l SET "organisation_id" = e."organisation_id"
FROM "events" e WHERE l."event_id" = e."id" AND l."organisation_id" IS NULL;

ALTER TABLE "surplus_listings" DROP CONSTRAINT "surplus_listings_organisation_id_fkey";
ALTER TABLE "surplus_listings" ALTER COLUMN "organisation_id" SET NOT NULL;
ALTER TABLE "surplus_listings" ADD CONSTRAINT "surplus_listings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "surplus_listings_organisation_id_idx" ON "surplus_listings"("organisation_id");

-- Near-expiry alert: when the one-time urgent notification went out (null = not yet)
ALTER TABLE "surplus_listings" ADD COLUMN "near_expiry_alerted_at" TIMESTAMP(3);

-- ---------------------------------------------------------------- 3. backfill existing rows

UPDATE "organisations"
SET "licence_number" = 'PENDING-' || "id", "licence_authority" = 'Not provided', "verification_status" = 'PENDING'
WHERE "type" <> 'NGO' AND "licence_number" IS NULL;

UPDATE "organisations" SET "ngo_type" = 'OTHER' WHERE "type" = 'NGO' AND "ngo_type" IS NULL;

-- ---------------------------------------------------------------- 4. hand-written CHECK constraints

-- organisation_id is always set (NOT NULL); event_id is set exactly when the source is EVENT
ALTER TABLE "surplus_listings" ADD CONSTRAINT "chk_listing_source" CHECK (
  ("source_type" = 'EVENT') = ("event_id" IS NOT NULL)
);

-- Donor businesses must hold a food licence; NGOs do not
ALTER TABLE "organisations" ADD CONSTRAINT "chk_donor_org_licence" CHECK (
  "type" = 'NGO' OR (
    "licence_number" IS NOT NULL AND length(trim("licence_number")) > 0 AND
    "licence_authority" IS NOT NULL AND length(trim("licence_authority")) > 0
  )
);

-- NGO-only fields: an NGO must have a type; donor businesses cannot have NGO fields
ALTER TABLE "organisations" ADD CONSTRAINT "chk_org_ngo_fields" CHECK (
  CASE WHEN "type" = 'NGO'
    THEN "ngo_type" IS NOT NULL
    ELSE "ngo_type" IS NULL AND "beneficiaries" IS NULL AND "show_in_directory" = false
  END
);

ALTER TABLE "organisations" ADD CONSTRAINT "chk_org_beneficiaries_nonneg" CHECK ("beneficiaries" IS NULL OR "beneficiaries" >= 0);
