-- Saved searches remember which query language they were written in.
--
-- Reloading a saved search re-parses its queryText, so without this the
-- advanced-syntax queries ("body CONTAINS x") would be handed to the simple
-- parser, which either rejects them or — worse — reads them as something else.
--
-- Defaults to 'simple' so every existing row keeps its current meaning.
ALTER TABLE "saved_searches"
  ADD COLUMN IF NOT EXISTS "syntax" TEXT NOT NULL DEFAULT 'simple';
