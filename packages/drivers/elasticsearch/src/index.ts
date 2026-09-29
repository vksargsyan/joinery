export { SearchAdapter, createSearchAdapter } from './adapter';
export { SEARCH_FOLDERS } from './browse';
export { checkSearchConnection, type SearchCheckClient, type SearchCheckDeps } from './check';
export { parseRoot, type RootInfo } from './cluster';
export {
  buildNodeTarget,
  buildSearchClientPlan,
  parseNodeUrl,
  redactSecrets,
  type ParsedNodeUrl,
  type SearchAuthMethod,
  type SearchClientPlan,
  type SearchNodeTarget,
} from './config';
export { mapResponseError, mapTransportError, type SearchErrorContext } from './errors';
export { CONSOLE_MAX_BYTES, RESPONSE_COLUMN } from './execute';
export {
  HttpTransportError,
  SearchHttpClient,
  encodeUrlPart,
  type HttpRequest,
  type HttpResponse,
} from './http';
export { ElasticSearchSession, isSearchSession, searchCoreCapabilities } from './session';
export { parsePublishAddress, sniffNodes } from './sniff';
export { searchProfileFromUrl } from './testing';
export type {
  ConcurrencyOptions,
  DeleteByQueryOptions,
  ForceMergeOptions,
  GetSettingsOptions,
  IndexDocumentOptions,
  ListIndicesOptions,
  RefreshPolicy,
  RequestOptions,
  SearchOpOptions,
  SearchPagingOptions,
  SearchSession,
  WriteOptions,
} from './types';
