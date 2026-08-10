/**
 * Error types for the EvidenceVault search query pipeline.
 */

/** Thrown by the lexer/parser when the query string is malformed. */
export class QuerySyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`Syntax error at position ${position}: ${message}`);
    this.name = 'QuerySyntaxError';
    this.position = position;
  }
}

/**
 * Thrown by validation (and field resolution) when a syntactically valid
 * query violates the field registry or cost limits. Collects every
 * violation so callers can present them all at once.
 */
export class QueryValidationError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`Query validation failed:\n- ${violations.join('\n- ')}`);
    this.name = 'QueryValidationError';
    this.violations = violations;
  }
}
