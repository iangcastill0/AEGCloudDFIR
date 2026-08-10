/** Base error for all production package failures. */
export class ProductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a bates number would exceed the configured digit width. */
export class BatesOverflowError extends ProductionError {}

/** Thrown when a bates string does not match the configured format. */
export class BatesParseError extends ProductionError {}
