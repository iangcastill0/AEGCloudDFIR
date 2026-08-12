import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import { createPrismaClient } from '@aeg-clouddfir/database';
import { APP_CONFIG, LOGGER, PRISMA } from '../common/tokens.js';
import { getAppConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';

/** App-wide singletons: validated config, pino logger, runtime Prisma client. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: getAppConfig },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig) => createLogger(config),
      inject: [APP_CONFIG],
    },
    {
      provide: PRISMA,
      useFactory: (config: AppConfig) => createPrismaClient(config.CDFIR_DATABASE_URL),
      inject: [APP_CONFIG],
    },
  ],
  exports: [APP_CONFIG, LOGGER, PRISMA],
})
export class CoreModule {}
