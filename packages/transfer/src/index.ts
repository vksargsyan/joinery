/**
 * @joinery/transfer — streaming import and export (spec §12).
 *
 * One pipeline for the wizards, scheduled jobs and joinery-cli: byte sources and sinks with
 * backpressure and optional gzip; incremental CSV/TSV, JSON and JSON Lines readers; preview
 * with format, encoding, dialect, header and type detection; column mapping and conversions;
 * batched, parameterised imports in five modes; streaming exports to CSV, TSV, JSON, JSON
 * Lines, SQL INSERTs and SQL with DDL; and "run SQL file". Never imports Electron: it runs in
 * the job runner utility process and in the CLI.
 */

export { EXPORT_FORMATS, FILE_FORMATS, isJsonText, jsonText } from './types';
export type {
  ExportFormat,
  FileFormat,
  JsonText,
  RowBatch,
  RowError,
  SourceCell,
  SourceRow,
  TransferProgress,
  TransferStatus,
  TransferSummary,
} from './types';

export {
  bytesSource,
  fileSink,
  fileSource,
  gunzip,
  gzipSink,
  isGzip,
  memorySink,
  readableSource,
  writableSink,
} from './io';
export type {
  ByteSource,
  FileSinkOptions,
  FileSourceOptions,
  MemorySink,
  Sink,
  WritableSinkOptions,
} from './io';

export { OUTPUT_ENCODINGS, decodeSource, detectEncoding } from './text';
export type { DetectedEncoding, OutputEncoding } from './text';

export { CSV_QUOTING, CsvFormatter, CsvParser, csvDialect, parseCsv } from './csv';
export type {
  CsvDialect,
  CsvField,
  CsvParseOptions,
  CsvQuoting,
  CsvRecords,
  CsvWriteOptions,
} from './csv';

export { JsonLinesParser, JsonStreamParser, parseJsonElement } from './json';
export type { JsonElement, JsonElements } from './json';

export { readRows } from './readers';
export type { CsvReadOptions, ReadOptions, RowFormat } from './readers';

export { ColumnInference, DATE_ORDERS, INFERRED_TYPES, inferColumns } from './infer';
export type { DateOrder, InferredColumn, InferredType } from './infer';

export {
  detectCsvOptions,
  detectDelimiter,
  detectHeader,
  formatFromFileName,
  previewSource,
  sniffFormat,
} from './detect';
export type { PreviewOptions, SourcePreview } from './detect';

export {
  ConversionError,
  TARGET_KINDS,
  autoMatch,
  converterFor,
  matchKey,
  sqlTypeFor,
  tableFromColumns,
  targetKind,
} from './mapping';
export type {
  ColumnMapping,
  ConversionOptions,
  Converter,
  TableFromColumnsOptions,
  TargetKind,
} from './mapping';

export { MAX_PARAMETERS, buildStatement, supportsRowAlias } from './statements';
export type { ImportMode, StatementPlan } from './statements';

export { importRows } from './import';
export type { ImportOptions, ImportSummary, TransactionMode } from './import';

export { runSqlFile } from './sql-file';
export type {
  SqlFileOptions,
  SqlFileProgress,
  SqlFileSummary,
  SqlStatementError,
} from './sql-file';

export { exportRows, exportTables } from './export';
export type {
  CsvExportOptions,
  ExportCommonOptions,
  ExportOptions,
  ExportSummary,
  ExportTable,
  ExportTablesOptions,
  ExportTablesSummary,
  JsonExportOptions,
  SqlExportOptions,
} from './export';

export { createTable, loadTable } from './session';
