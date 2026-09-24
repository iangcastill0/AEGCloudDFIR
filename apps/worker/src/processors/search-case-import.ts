import type { WorkerContext } from '../context.js';
import type { CaseImportPayload } from './payloads.js';

export async function processSearchCaseImport(
  ctx: WorkerContext,
  payload: CaseImportPayload,
): Promise<void> {
  const result = await ctx.search.addCaseToImport(
    payload.tenantId,
    payload.importId,
    payload.caseId,
  );
  ctx.log.info(
    {
      caseId: payload.caseId,
      importId: payload.importId,
      updated: result.updated,
      unchanged: result.unchanged,
      conflicts: result.conflicts,
    },
    'case added to every indexed document in import',
  );
}
