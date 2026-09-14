-- Every collection belongs to a case.
--
-- Collecting was the easy half. What an operator actually wants is the
-- evidence sitting somewhere they can review, and until now that meant
-- creating a case by hand and then adding the collection to it — a step that
-- is easy to forget and silent when forgotten. A collection with no case looks
-- finished while being unreviewable.
--
-- Nullable, because collections made before this migration have no case and
-- inventing one for them retroactively would fabricate a record of a decision
-- nobody made. Everything created from now on has one.
--
-- No ON DELETE CASCADE: deleting a case must never delete collections or the
-- evidence under them. The FK default (RESTRICT) is what we want — it refuses
-- to delete a case that still has collections pointing at it.
ALTER TABLE "collections" ADD COLUMN "caseId" UUID;

ALTER TABLE "collections"
  ADD CONSTRAINT "collections_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "collections_caseId_idx" ON "collections"("caseId");
