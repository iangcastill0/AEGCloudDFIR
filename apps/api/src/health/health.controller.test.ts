import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { PrismaClient } from '@aeg-clouddfir/database';
import { HealthController } from './health.controller.js';

const config = { CDFIR_WEB_PUBLIC_URL: 'https://app.example.com' } as AppConfig;
const prisma = {} as PrismaClient;

describe('HealthController', () => {
  it('liveness reports ok without touching any dependency', () => {
    // prisma is an empty object: if healthz queried anything this would throw,
    // which is the point — liveness must not depend on the database.
    expect(new HealthController(config, prisma).healthz()).toEqual({ status: 'ok' });
  });

  it('redirects the root path to the configured web app', () => {
    // The apex sends sign-ins through the API host, so a bare 404 at / reads as
    // an outage to anyone who lands there.
    expect(new HealthController(config, prisma).root()).toEqual({
      url: 'https://app.example.com',
    });
  });

  it('derives the redirect target from config rather than hardcoding a host', () => {
    const other = { CDFIR_WEB_PUBLIC_URL: 'https://review.other.test' } as AppConfig;
    expect(new HealthController(other, prisma).root().url).toBe('https://review.other.test');
  });
});
