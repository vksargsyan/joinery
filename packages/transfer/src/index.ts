/**
 * @joinery/transfer — streaming import and export (spec §12).
 *
 * One pipeline for the wizards, scheduled jobs and joinery-cli: byte sources and sinks with
 * backpressure, optional gzip and ZIP; incremental CSV/TSV, JSON, JSON Lines and XML readers
 * and a streaming Excel (.xlsx) reader; preview with format, encoding, dialect, header, sheet,
 * row path and type detection; column mapping and conversions; batched, parameterised imports
 * in five modes; streaming exports to CSV, TSV, JSON, JSON Lines, Excel, XML, SQL INSERTs, SQL
 * with DDL, HTML and Markdown; and "run SQL file". Never imports Electron: it runs in the job
 * runner utility process and in the CLI. ZIP, XML and xlsx are written here on node:zlib
 * (ADR 0012), with no third-party dependency.
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
  memoryReader,
  memorySink,
  openFileReader,
  randomAccess,
  readableSource,
  spoolToFile,
  writableSink,
} from './io';
export type {
  ByteSource,
  FileSinkOptions,
  FileSourceOptions,
  MemorySink,
  RandomAccessReader,
  Sink,
  SpooledSource,
  WritableSinkOptions,
} from './io';

export { ZipReader, ZipWriter, isCompoundFile, isZip } from './zip';
export type { ZipEntry, ZipWriterOptions } from './zip';

export {
  XmlParser,
  attribute,
  decodeHexEscapes,
  decodeXmlName,
  escapeXmlAttribute,
  escapeXmlText,
  localName,
  xmlName,
} from './xml';
export type { XmlHandler, XmlParserOptions } from './xml';

export { XmlRowBuilder, detectRowPaths, normalizeRowPath, xmlEncoding } from './xml-read';
export type { XmlPathCandidate, XmlReadOptions } from './xml-read';

export {
  Workbook,
  XlsxRowBuilder,
  columnName,
  formatKind,
  numberCell,
  openWorkbook,
  readSheet,
  serialToText,
} from './xlsx-read';
export type { SheetRow, WorksheetInfo, XlsxReadOptions } from './xlsx-read';

export {
  XLSX_MAX_COLUMNS,
  XLSX_MAX_ROWS,
  XlsxSheetWriter,
  XlsxWorkbookWriter,
  exactDecimal,
  excelDate,
  sheetName,
} from './xlsx-write';
export type { XlsxExportOptions } from './xlsx-write';

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
  detectHeaderRow,
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

export {
  EXPORT_EXTENSIONS,
  combinableFormat,
  exportFileName,
  exportRows,
  exportTables,
  markdownCell,
} from './export';
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

// Data transfer between databases (spec §12): SQL ↔ SQL, SQL ↔ MongoDB, Redis → Redis.
export { planDbTransfer, runDbTransfer, transferSupport } from './db/transfer';
export type { PlanDbTransferOptions, RunDbTransferOptions } from './db/transfer';
export {
  DB_TABLE_MODES,
  DEFAULT_DB_TRANSFER_OPTIONS,
  FIELD_SHAPES,
  resolveOptions as resolveDbTransferOptions,
} from './db/spec';
export type {
  ColumnOverride,
  DbTableMode,
  DbTransferError,
  DbTransferOptions,
  DbTransferProgress,
  DbTransferSpec,
  DbTransferSummary,
  DbTransferTableSummary,
  EmbedSpec,
  FieldShape,
  OpenedSession,
  PlannedAction,
  PlannedColumn,
  PlannedTable,
  SessionOpener,
  TransferObjectSpec,
  TransferPlan,
} from './db/spec';
export { isIntegerType, mapSqlType } from './db/type-map';
export type { ReadForm, TypeMapping, TypeMappingContext } from './db/type-map';
export {
  MONGO_FIELD_TYPES,
  bsonCell,
  flattenCollection,
  mongoFieldType,
  sqlTypeForBson,
  toBsonValue,
} from './db/mongo-map';
export type { FlatColumn, FlatTable, FlattenOptions, MongoFieldType } from './db/mongo-map';
export { isSafeDataType, safeColumnName } from './db/names';
export { globMatch } from './db/redis-transfer';
export type { MongoTransferSession, RedisTransferSession } from './db/sessions';
