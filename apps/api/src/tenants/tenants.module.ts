import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller.js';

@Module({
  controllers: [TenantsController],
})
export class TenantsModule {}
