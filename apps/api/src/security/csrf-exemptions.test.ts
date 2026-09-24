import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator.js';

/**
 * The registry test for CSRF exemptions.
 *
 * `packages/connectors/src/oauth.test.ts` walks every exported `build*Url` and
 * fails if a new one skips `prompt=select_account`. Same idea, and for the same
 * reason: a rule that lives in a comment gets broken by the next person, while
 * a rule that fails a build does not.
 *
 * So this does not check the one route we know about. It finds EVERY controller
 * file on disk, reads every route off it, and asserts the set of CSRF-exempt
 * routes is exactly one. A second `@SkipCsrf()` added quietly later — on a route
 * that takes a session cookie, which is the dangerous case — fails here and
 * names itself in the diff.
 */

const SRC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Exactly the routes allowed out of the global CSRF check, and why.
 *
 * Adding a line here is a security decision. The only sound reason is that the
 * handler authenticates by `Authorization: Bearer` ALONE — no session cookie, no
 * other ambient credential. See `skip-csrf.decorator.ts`.
 */
const EXPECTED_EXEMPT_ROUTES: Record<string, string> = {
  'POST api/v1/exports/:id/download/urls':
    'Authenticated only by the scoped export download token in an Authorization header, on a controller with no session guard. Its callers are curl and PowerShell, which have no cookie jar and so can never satisfy a double-submit check.',
};

interface Route {
  /** e.g. `POST api/v1/exports/:id/download/urls` */
  signature: string;
  controller: string;
  handler: string;
  file: string;
  exempt: boolean;
}

function controllerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...controllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

function joinPath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((p) => p.split('/'))
    .filter((s) => s !== '' && s !== '/');
  return segments.join('/');
}

function isControllerClass(value: unknown): value is new (...args: never[]) => unknown {
  return typeof value === 'function' && Reflect.getMetadata(PATH_METADATA, value) !== undefined;
}

async function collectRoutes(): Promise<Route[]> {
  const routes: Route[] = [];

  for (const file of controllerFiles(SRC_DIR)) {
    const module: Record<string, unknown> = await import(pathToFileURL(file).href);

    for (const exported of Object.values(module)) {
      if (!isControllerClass(exported)) continue;
      const controllerPath = String(Reflect.getMetadata(PATH_METADATA, exported));
      const proto: object = exported.prototype;

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler: unknown = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof verb !== 'number') continue;

        const handlerPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        routes.push({
          signature: `${RequestMethod[verb] ?? String(verb)} ${joinPath(controllerPath, handlerPath)}`,
          controller: exported.name,
          handler: name,
          file: relative(SRC_DIR, file),
          exempt: Reflect.getMetadata(SKIP_CSRF_KEY, handler) === true,
        });
      }
    }
  }

  return routes;
}

describe('CSRF exemptions across the whole API', () => {
  /**
   * Guards the guard. If the walk above silently found nothing — a rename, a
   * failed import, a Nest metadata key that moved — then "no route is exempt"
   * would be trivially true and every assertion below would pass while checking
   * nothing. This repo has been bitten by a test that passed either way.
   */
  it('really does find the API surface', async () => {
    const routes = await collectRoutes();
    expect(routes.length).toBeGreaterThan(40);

    const signatures = routes.map((r) => r.signature);
    // Ordinary routes that must exist, one read and one mutating.
    expect(signatures).toContain('GET api/v1/exports/:id');
    expect(signatures).toContain('POST api/v1/exports');
    // And the route the whole exemption exists for.
    expect(signatures).toContain('POST api/v1/exports/:id/download/urls');
  });

  it('exempts exactly the routes on the list and nothing else', async () => {
    const routes = await collectRoutes();
    const exempt = routes
      .filter((r) => r.exempt)
      .map((r) => r.signature)
      .sort();

    expect(exempt).toEqual(Object.keys(EXPECTED_EXEMPT_ROUTES).sort());
  });

  it('every exemption carries a written reason', async () => {
    // The list is only acceptable while it explains itself, and the reason has
    // to be the one that makes it safe.
    const routes = await collectRoutes();
    for (const [signature, reason] of Object.entries(EXPECTED_EXEMPT_ROUTES)) {
      expect(
        routes.some((r) => r.signature === signature),
        `${signature} is not a real route`,
      ).toBe(true);
      expect(reason.length, `${signature} needs a reason`).toBeGreaterThan(80);
      expect(reason).toMatch(/Authorization|Bearer/);
    }
  });

  it('no controller class carries the exemption', async () => {
    // Class-level metadata would exempt every route on that controller. The
    // guard ignores it, but a class carrying the mark is still a mistake worth
    // naming, and it would mislead anyone reading the controller.
    const marked: string[] = [];
    for (const file of controllerFiles(SRC_DIR)) {
      const module: Record<string, unknown> = await import(pathToFileURL(file).href);
      for (const exported of Object.values(module)) {
        if (!isControllerClass(exported)) continue;
        if (Reflect.getMetadata(SKIP_CSRF_KEY, exported) === true) marked.push(exported.name);
      }
    }
    expect(marked).toEqual([]);
  });

  it('the exempt route sits on a controller with no session guard', async () => {
    /*
     * The property that makes the exemption sound, checked rather than trusted.
     * `@UseGuards(SessionGuard, ...)` opens the session cookie and attaches it,
     * and a route that can be authenticated by a cookie is exactly what CSRF
     * protects. So the exempt handler must sit on a controller that has no
     * guards at all — it authenticates itself, from the Authorization header.
     */
    const { ExportDownloadRefreshController } = await import('../exports/exports.controller.js');
    expect(Reflect.getMetadata('__guards__', ExportDownloadRefreshController)).toBeUndefined();
    expect(
      Reflect.getMetadata('__guards__', ExportDownloadRefreshController.prototype.refresh),
    ).toBeUndefined();
  });
});
