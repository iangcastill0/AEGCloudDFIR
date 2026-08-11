import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SearchModule } from '../search/search.module.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { ExportsService } from './exports.service.js';
import { ExportsController } from './exports.controller.js';

@Module({
  imports: [AuditModule, SearchModule, EvidenceStoreModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
