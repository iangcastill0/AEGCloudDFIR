import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export interface CursorQuery {
  limit: number;
  cursor?: string;
}

/**
 * Validate cursor-pagination query params. limit is capped at 100; the cursor
 * is the id (UUID) of the last row of the previous page.
 */
export function parseCursorQuery(query: unknown): CursorQuery {
  const result = cursorQuerySchema.safeParse(query ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new BadRequestException({ message: 'invalid pagination parameters', details });
  }
  return result.data;
}
