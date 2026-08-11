import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SearchModule } from '../search/search.module.js';
import { CasesService } from './cases.service.js';
import { CasesController } from './cases.controller.js';

@Module({
  imports: [AuditModule, SearchModule],
  controllers: [CasesController],
  providers: [CasesService],
})
export class CasesModule {}
