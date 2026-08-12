import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '@aeg-clouddfir/config';
import { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import { APP_CONFIG, EVIDENCE_STORE } from '../common/tokens.js';

/** EvidenceObjectStore over the configured S3-compatible endpoint. */
@Module({
  providers: [
    {
      provide: EVIDENCE_STORE,
      useFactory: (config: AppConfig): EvidenceObjectStore =>
        new EvidenceObjectStore({
          s3: new S3Client({
            endpoint: config.CDFIR_S3_ENDPOINT,
            region: config.CDFIR_S3_REGION,
            forcePathStyle: config.CDFIR_S3_FORCE_PATH_STYLE,
            credentials: {
              accessKeyId: config.CDFIR_S3_ACCESS_KEY_ID,
              secretAccessKey: config.CDFIR_S3_SECRET_ACCESS_KEY,
            },
          }),
          evidenceBucket: config.CDFIR_S3_BUCKET_EVIDENCE,
          quarantineBucket: config.CDFIR_S3_BUCKET_QUARANTINE,
          presignTtlSeconds: config.CDFIR_S3_PRESIGN_TTL_SECONDS,
        }),
      inject: [APP_CONFIG],
    },
  ],
  exports: [EVIDENCE_STORE],
})
export class EvidenceStoreModule {}
