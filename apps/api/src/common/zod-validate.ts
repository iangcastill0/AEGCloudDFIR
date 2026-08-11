import { BadRequestException } from '@nestjs/common';

/**
 * Structural view of a zod schema so contract schemas validate regardless of
 * which workspace copy of zod produced them.
 */
export interface ParsableSchema<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a request body against a contract schema. Throws BadRequest with
 * the full issue list (paths + messages, never raw values) on failure.
 */
export function zodValidate<T>(schema: ParsableSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    throw new BadRequestException({ message: 'validation failed', issues });
  }
  return result.data;
}
