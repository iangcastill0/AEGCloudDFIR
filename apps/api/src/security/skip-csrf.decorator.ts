import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'ev:skipCsrf';

/**
 * Take one handler out of the global CSRF check. Only safe when the handler
 * authenticates by `Authorization: Bearer` ALONE.
 *
 * Why that is safe: CSRF is an attack on *ambient* credentials. A browser
 * attaches cookies to a cross-site request all by itself, so a form on an
 * attacker's page can act as the signed-in user. It cannot attach an
 * `Authorization` header the same way — setting one makes the request
 * non-simple, so the browser sends a preflight first, and the attacker's origin
 * fails it. A handler that reads only a Bearer token therefore has nothing for
 * CSRF to steal, and the double-submit check on it is pure breakage: a download
 * script has no cookie jar, so its first refresh call 403s and the download
 * dies.
 *
 * The reasoning collapses if the handler ALSO accepts a session cookie. Then
 * the cookie is ambient again and skipping CSRF opens a real hole. Before
 * putting this on anything, read the handler and its guards and check that a
 * logged-in browser with no Bearer token gets nothing.
 *
 * Deliberately typed `MethodDecorator`, not Nest's `CustomDecorator` (which is
 * also a `ClassDecorator`): `@SkipCsrf()` on a controller class would exempt
 * every route on it, including ones added later by someone who never read this.
 * TypeScript refuses that here, and `CsrfGuard` reads handler metadata only, so
 * it would not work even if the types were bypassed.
 */
export const SkipCsrf = (): MethodDecorator => SetMetadata(SKIP_CSRF_KEY, true);
