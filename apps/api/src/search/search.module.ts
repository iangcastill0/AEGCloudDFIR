import { Module } from '@nestjs/common';
import type { AppConfig } from '@evidencevault/config';
import { OpenSearchAdapter, type SearchAdapter } from '@evidencevault/search';
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
          node: config.EV_OPENSEARCH_URL,
          username: config.EV_OPENSEARCH_USERNAME,
          password: config.EV_OPENSEARCH_PASSWORD,
          indexPrefix: config.EV_OPENSEARCH_INDEX_PREFIX,
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
