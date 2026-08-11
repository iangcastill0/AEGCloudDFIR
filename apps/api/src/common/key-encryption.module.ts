import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '@evidencevault/config';
import { LocalAesKeyEncryptionProvider, type KeyEncryptionProvider } from '@evidencevault/database';
import { APP_CONFIG, KEY_ENCRYPTION } from './tokens.js';

/**
 * Envelope-encryption KEK provider, constructed once from configuration.
 * Only the local AES provider is wired today (EV_KEK_PROVIDER enum).
 */
@Global()
@Module({
  providers: [
    {
      provide: KEY_ENCRYPTION,
      useFactory: (config: AppConfig): KeyEncryptionProvider =>
        new LocalAesKeyEncryptionProvider(
          { [config.EV_KEK_ACTIVE_KEY_ID]: config.EV_KEK_LOCAL_MASTER_KEY },
          config.EV_KEK_ACTIVE_KEY_ID,
        ),
      inject: [APP_CONFIG],
    },
  ],
  exports: [KEY_ENCRYPTION],
})
export class KeyEncryptionModule {}
