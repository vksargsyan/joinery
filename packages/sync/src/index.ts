/**
 * @joinery/sync — structure sync and data compare (spec §13).
 *
 * Structure: `compareSchemas` diffs two schema snapshots into ordered, tickable operations;
 * `generateScript` turns the selected ones into a deployment script; `renderHtmlReport`
 * exports the comparison. The DDL renderers are shared with the table designer and ER forward
 * engineering.
 *
 * Table designer: `designTable` diffs an edited table against the live one through the same
 * engine and adds data-loss analysis and validation; `typeCatalog` feeds the type dropdown.
 *
 * Data: value canonicalisation, checksum SQL, range planning, the sorted-stream merge, sync
 * script generation and `compareTableData`, which drives two `Session`s.
 */

export * from './model';
export * from './options';
export { compareSchemas, summarizeDiff } from './compare';
export { diffSchemas } from './diff/index';
export { generateScript, formatStatements, isCompoundStatement } from './script';
export type { GeneratedScript, ScriptOptions, ScriptStatement } from './script';
export { setOperationSelected, setAllSelected, missingDependencies } from './selection';
export { renderHtmlReport, escapeHtml } from './report';
export type { HtmlReportOptions } from './report';
export { renderSnapshotDdl } from './forward';
export {
  normalizeSnapshot,
  contextFor,
  canonicalDefault,
  canonicalColumn,
  canonicalExpression,
} from './normalize';
export type { NormalizeContext } from './normalize';
export { canonicalType, canonicalPgType, canonicalMysqlType, typeChangeRisk } from './types';
export {
  isGeneratedName,
  mysqlAccount,
  objectName,
  renderCheck,
  renderColumn,
  renderCreateTable,
  renderDropRoutine,
  renderDropTrigger,
  renderEvent,
  renderExtension,
  renderForeignKey,
  renderMysqlIndexClause,
  renderOwnedBy,
  renderPgCreateIndex,
  renderPrimaryKey,
  renderRoutine,
  renderSchema,
  renderSequence,
  renderTableStatements,
  renderTrigger,
  renderType,
  renderUnique,
  renderView,
} from './render';
export type { ColumnRenderOptions, RenderOptions, ViewRenderOptions } from './render';
export { normalizeSql, tokenizeSql, referencedNames } from './sql-text';
export type { SqlToken, SqlTokenKind } from './sql-text';

export * from './designer/index';

export {
  canonicalValue,
  canonicalDecimal,
  canonicalJson,
  canonicalTimestamp,
  compareCodePoints,
  compareDecimals,
  compareKeyValues,
  compareKeys,
  compareKind,
  valuesEqual,
} from './data/canonical';
export type { CanonicalOptions } from './data/canonical';
export {
  boundaryQuery,
  checksumQuery,
  columnsQuery,
  rowsQuery,
  sqlLiteral,
  tableName,
} from './data/sql';
export type { KeyRange, SqlQuery, TableRef } from './data/sql';
export { columnIndex, mergeSortedRows, planMerge } from './data/merge';
export type { MergeOptions, MergePlan, MergeSummary, Row, RowAction, RowDiff } from './data/merge';
export { DataSyncScriptBuilder, generateDataSyncScript } from './data/script';
export type { DataSyncOptions, DataSyncScript } from './data/script';
export { compareTableData } from './data/compare';
export type {
  DataCompareEvent,
  DataCompareOptions,
  DataCompareSummary,
  TablePair,
} from './data/compare';
