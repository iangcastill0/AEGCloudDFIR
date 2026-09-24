import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [AuditModule, EvidenceStoreModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
