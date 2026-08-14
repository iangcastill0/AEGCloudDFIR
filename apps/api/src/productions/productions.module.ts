import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SearchModule } from '../search/search.module.js';
import { EvidenceStoreModule } from '../evidence/evidence-store.module.js';
import { ProductionsService } from './productions.service.js';
import { ProductionsController } from './productions.controller.js';

@Module({
  imports: [AuditModule, SearchModule, EvidenceStoreModule],
  controllers: [ProductionsController],
  providers: [ProductionsService],
})
export class ProductionsModule {}
