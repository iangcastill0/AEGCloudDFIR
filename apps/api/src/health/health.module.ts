import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { SearchModule } from '../search/search.module.js';

// readyz probes object storage and search as well as the database, so both must
// be injectable here.
@Module({ imports: [EvidenceStoreModule, SearchModule], controllers: [HealthController] })
export class HealthModule {}
