import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ConnectorsService } from './connectors.service.js';
import { ConnectorsCallbackController, ConnectorsController } from './connectors.controller.js';

@Module({
  imports: [AuditModule],
  controllers: [ConnectorsController, ConnectorsCallbackController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
