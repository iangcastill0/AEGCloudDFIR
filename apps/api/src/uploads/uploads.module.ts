import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { UploadsService } from './uploads.service.js';
import { UploadsController } from './uploads.controller.js';

@Module({
  imports: [AuditModule, EvidenceStoreModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
