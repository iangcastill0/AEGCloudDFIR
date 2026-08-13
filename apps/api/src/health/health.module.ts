import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';

// readyz probes object storage as well as the database, so the store must be
// injectable here.
@Module({ imports: [EvidenceStoreModule], controllers: [HealthController] })
export class HealthModule {}
