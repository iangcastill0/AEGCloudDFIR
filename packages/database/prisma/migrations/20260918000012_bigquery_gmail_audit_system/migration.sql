-- AlterEnum
-- Add the BigQuery Gmail audit system. Gmail message events (incl. "Message
-- viewed") can be collected from the Google Workspace "logs and reports in
-- BigQuery" export as an alternative/deeper source to the Admin SDK Reports
-- `gmail` application; those records are persisted as AuditRecords with this
-- system so their provenance (BigQuery export vs Reports API) stays explicit.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction alongside statements that
-- use the new value, so this migration contains ONLY the enum addition.
ALTER TYPE "AuditSystem" ADD VALUE IF NOT EXISTS 'google_bigquery_gmail';
