/**
 * @joinery/search-tools — what the Elasticsearch and OpenSearch module (spec §11) needs on both
 * sides of the process boundary: the Kibana console parser and formatter, lossless JSON text
 * helpers, the request safety classifier behind the write rules, the wire types, the capability
 * flags, reply readers, and autocomplete from the open Elasticsearch API specification. No Node
 * built-ins: the sandboxed renderer imports it too.
 */

export {
  API_SPEC,
  endpointFor,
  isPlaceholder,
  matchEndpoints,
  type ApiEndpoint,
  type ApiSpec,
  type ApiType,
  type EndpointMatch,
} from './api/spec';
export {
  SEARCH_DISTRIBUTIONS,
  distributionName,
  searchCapabilities,
  versionAtLeast,
  type SearchCapabilities,
  type SearchDistribution,
  type SearchServerFacts,
} from './capabilities';
export {
  completeConsole,
  type CompletionItem,
  type CompletionKind,
  type ConsoleCompletion,
  type ConsoleCompletionOptions,
} from './completion';
export {
  HTTP_METHODS,
  bodyErrorOffset,
  bodyKindForPath,
  formatConsoleRequest,
  isRequestLine,
  issuesOf,
  offsetOfLineColumn,
  parseConsole,
  requestAt,
  requestsIn,
  sourceOffset,
  splitUrl,
  type BodySegment,
  type ConsoleIssue,
  type ConsoleParse,
  type ConsoleRequest,
  type HttpMethod,
} from './console/parser';
export {
  JsonSyntaxError,
  booleanAt,
  compactJson,
  formatJson,
  member,
  nodeAt,
  nodeText,
  numberAt,
  parseJsonTree,
  parseJsonValueAt,
  quoteJson,
  readJsonString,
  stringAt,
  toLooseJson,
  type FormatJsonOptions,
  type JsonMember,
  type JsonNode,
  type LooseJson,
} from './json';
export { parseSearchError, parseSearchReply, type SearchErrorInfo } from './response';
export { classifyRequest, type RequestSafety } from './safety';
export type {
  JsonText,
  SearchAliasInfo,
  SearchBulkItem,
  SearchBulkResult,
  SearchByQueryResult,
  SearchClusterHealth,
  SearchClusterInfo,
  SearchDataStreamInfo,
  SearchDocument,
  SearchHealthStatus,
  SearchHit,
  SearchIndexSummary,
  SearchNodeSummary,
  SearchPage,
  SearchRequest,
  SearchResponse,
  SearchWriteResult,
} from './wire';
