import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EvidenceStoreModule } from './evidence-store.module.js';
import { EvidenceService } from './evidence.service.js';
import { EvidenceController } from './evidence.controller.js';

@Module({
  imports: [AuditModule, EvidenceStoreModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceStoreModule],
})
export class EvidenceModule {}
