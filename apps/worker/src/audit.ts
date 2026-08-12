/**
 * Audit-log wiring helpers. The connector SPI itself (AuditConnector,
 * AuditBatch, AuditListPage, FetchAuditPageOptions) lives in
 * @aeg-clouddfir/connectors; this module only adds the worker-side routing that
 * maps a persisted checkpoint scopeKey back to the connector that owns it.
 *
 * A collection can enumerate scopes from up to four audit connectors whose
 * provider-native scopeKeys (content types, 'directoryAudits'/'signIns',
 * application names, matter ids) are not globally unique, so each checkpoint
 * scopeKey is composed as `${kind}::${rawScopeKey}` where kind identifies the
 * owning connector.
 */
import type { AuditConnector } from '@aeg-clouddfir/connectors';

/** Identifies which audit connector owns a scope (for routing, not the system). */
export type AuditConnectorKind =
  'o365_management_activity' | 'graph_audit' | 'google_reports' | 'google_vault';

/** An audit connector tagged with its routing kind. */
export interface TaggedAuditConnector {
  kind: AuditConnectorKind;
  connector: AuditConnector;
}

/** Bundle of the audit connectors constructed for one connector account. */
export interface AuditConnectorBundle {
  provider: 'microsoft' | 'google';
  mode: 'delegated' | 'organization';
  connectors: TaggedAuditConnector[];
}

/** Raised when audit collection is attempted on a delegated-only connector. */
export class AuditRequiresOrganizationModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRequiresOrganizationModeError';
  }
}

/** Separator composing a checkpoint scopeKey as `${kind}::${scopeKey}`. */
export const AUDIT_SCOPE_SEP = '::';

export function composeAuditScopeKey(kind: AuditConnectorKind, scopeKey: string): string {
  return `${kind}${AUDIT_SCOPE_SEP}${scopeKey}`;
}

export function parseAuditScopeKey(composite: string): {
  kind: AuditConnectorKind;
  scopeKey: string;
} {
  const idx = composite.indexOf(AUDIT_SCOPE_SEP);
  if (idx < 0) {
    return { kind: 'o365_management_activity', scopeKey: composite };
  }
  return {
    kind: composite.slice(0, idx) as AuditConnectorKind,
    scopeKey: composite.slice(idx + AUDIT_SCOPE_SEP.length),
  };
}
