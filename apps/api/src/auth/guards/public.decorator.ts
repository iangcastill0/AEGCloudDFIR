import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'ev:isPublic';

/** Marks a route as reachable without a session (SessionGuard skips it). */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
