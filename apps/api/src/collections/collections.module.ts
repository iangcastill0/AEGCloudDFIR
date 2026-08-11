import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CollectionsService } from './collections.service.js';
import { CollectionsController } from './collections.controller.js';

@Module({
  imports: [AuditModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
})
export class CollectionsModule {}
