import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { CollectionsService } from './collections.service.js';
import { CollectionsController } from './collections.controller.js';

@Module({
  imports: [AuditModule, EvidenceStoreModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
})
export class CollectionsModule {}
