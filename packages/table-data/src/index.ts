/**
 * @querybara/table-data — the engine behind browsing and editing table data (spec §7).
 *
 * Pure logic and SQL generation over the core Session contract, for PostgreSQL, MySQL and
 * MariaDB: row identity, the filter model, keyset/offset page queries, counts and estimates,
 * the pending changes model and its transactional apply, typed cell parsing, foreign key
 * lookups, and copy/paste. Nothing here needs Node.js: the grid keeps its ChangeSet in the
 * renderer and plans there, and the plan and queries are plain structured-clone-safe data that
 * cross to the connection host, where `applyChanges` and the other runners drive the Session.
 */

export { DEFAULT, isDefault, isLargeValue, sameValue } from './values';
export type { DefaultValue, EditValue } from './values';

export {
  canSort,
  columnFromMeta,
  describeColumn,
  describeColumns,
  kindForDataType,
  parseEnumLabels,
} from './columns';
export type { ColumnInfo, DescribeColumnsOptions } from './columns';

export {
  allColumnsIdentity,
  canEdit,
  describeRow,
  isInsertKey,
  rowIdentity,
  rowKeyAt,
  rowKeyOf,
} from './identity';
export type { RowIdentity, RowKey, UnreliableColumn } from './identity';

export { sqlLiteral } from './sql';
export type { SqlQuery, TableRef } from './sql';

export { checkRawWhere } from './raw-where';
export type { RawWhereCheck } from './raw-where';

export {
  FILTER_OPERATORS,
  and,
  condition,
  escapeLike,
  operatorsFor,
  or,
  validateFilter,
} from './filter';
export type {
  FilterCondition,
  FilterGroup,
  FilterIssue,
  FilterNode,
  FilterOperator,
} from './filter';

export {
  buildBrowseQuery,
  buildCountQuery,
  buildEstimateQuery,
  pageAfter,
  pageBefore,
  parseEstimate,
} from './browse';
export type {
  BrowseOptions,
  BrowsePage,
  BrowseQuery,
  EstimateQuery,
  EstimateSource,
  FilterOptions,
  SortTerm,
} from './browse';

export { ChangeSet, createChangeStore } from './changes';
export type {
  ChangeCounts,
  ChangeDraft,
  ChangeListener,
  ChangeStore,
  ExistingRow,
  RowChange,
  RowInsert,
  RowStatus,
} from './changes';

export { planChanges } from './plan';
export type { ChangePlan, PlanOptions, PlannedStatement } from './plan';

export { applyChanges } from './apply';
export type { AppliedRow, ApplyResult } from './apply';

export { countRows, estimateRows, fetchPage, runQuery } from './session';
export type { FetchedPage, RunOptions, StatementResult } from './session';

export { formatCell, integerBounds, parseCellInput } from './cells';
export type { CellParseResult, ParseOptions } from './cells';

export {
  buildLookupQuery,
  buildReferencedRowQuery,
  foreignKeysOf,
  guessLabelColumn,
  referencedTable,
} from './foreign-keys';
export type {
  ForeignKeyOptions,
  LookupOptions,
  LookupQuery,
  ReferencedRowQuery,
} from './foreign-keys';

export { COPY_FORMATS, copyRows } from './copy';
export type { CopyFormat, CopyOptions } from './copy';

export { mapPastedRows, parsePastedText, pasteIntoChangeSet } from './paste';
export type { PastedCell, PastedRows, PasteResult, PasteTarget } from './paste';
