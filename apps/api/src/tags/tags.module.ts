import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { TagsService } from './tags.service.js';
import { TagsController } from './tags.controller.js';

@Module({
  imports: [AuditModule],
  controllers: [TagsController],
  providers: [TagsService],
})
export class TagsModule {}
