import { Module } from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import { OpenSearchAdapter, type SearchAdapter } from '@aeg-clouddfir/search';
import { APP_CONFIG, SEARCH_ADAPTER } from '../common/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { SearchService } from './search.service.js';
import { SelectionService } from './selection.service.js';
import { SavedSearchesService } from './saved-searches.service.js';
import { SavedSearchesController, SearchController } from './search.controller.js';

@Module({
  imports: [AuditModule],
  controllers: [SearchController, SavedSearchesController],
  providers: [
    {
      provide: SEARCH_ADAPTER,
      useFactory: (config: AppConfig): SearchAdapter =>
        new OpenSearchAdapter({
          node: config.CDFIR_OPENSEARCH_URL,
          username: config.CDFIR_OPENSEARCH_USERNAME,
          password: config.CDFIR_OPENSEARCH_PASSWORD,
          indexPrefix: config.CDFIR_OPENSEARCH_INDEX_PREFIX,
        }),
      inject: [APP_CONFIG],
    },
    SearchService,
    SelectionService,
    SavedSearchesService,
  ],
  exports: [SEARCH_ADAPTER, SearchService, SelectionService],
})
export class SearchModule {}
