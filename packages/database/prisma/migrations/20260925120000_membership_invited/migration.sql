-- People who joined through an invite or a standing join link skip the plan wall.
-- A membership created by starting a new organization stays invited = false.

ALTER TABLE "memberships"
  ADD COLUMN "invited" BOOLEAN NOT NULL DEFAULT false;

UPDATE "memberships" AS m
SET "invited" = true
FROM "audit_events" AS a
WHERE a."action" = 'tenant.member_joined'
  AND a."summary"->>'via' IN ('invite', 'join_link')
  AND a."tenantId" = m."tenantId"
  AND a."targetId" = m."userId"::text;
