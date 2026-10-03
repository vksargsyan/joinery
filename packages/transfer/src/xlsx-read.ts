import { QuerybaraError } from '@querybara/core';

import {
  gunzip,
  isGzip,
  peekSource,
  randomAccess,
  type ByteSource,
  type RandomAccessReader,
} from './io';
import { headerNames, widen, type BatchParts } from './rows';
import { jsonText, type SourceCell } from './types';
import { XmlParser, attribute, decodeHexEscapes, localName, type XmlHandler } from './xml';
import { ZipReader, isCompoundFile, isZip, type ZipEntry } from './zip';

/**
 * Excel workbooks (.xlsx, spec §12), read as streams: a workbook is a ZIP of XML parts, so
 * the ZIP is read from its central directory and the chosen worksheet is inflated and parsed
 * with the SAX parser chunk by chunk. Memory holds the shared string table (which every cell
 * may point into) and one row, never the sheet.
 *
 * Cells arrive typed: numbers as numbers (integers beyond 2^53 as bigint, and numbers a
 * JavaScript number would not print digit for digit as their exact text), booleans as
 * booleans, shared and inline strings (rich text runs joined, phonetic runs left out, OOXML
 * `_xHHHH_` escapes decoded) as text, formulas as their cached value, and error values
 * (`#N/A`, `#DIV/0!`...) as NULL. Numbers in a date or time format become ISO text:
 * `2024-01-02`, `2024-01-02 03:04:05[.678]` or `03:04:05`, in the workbook's 1900 or 1904
 * date system, to the millisecond.
 */

/** Options for reading a worksheet. */
export interface XlsxReadOptions {
  /** Worksheet name (default: the first visible worksheet). */
  readonly sheet?: string;
  /**
   * The worksheet row (1-based, as Excel numbers it) holding the column names; rows above it
   * are skipped. `0`: no header row. Default: the first row that has a value.
   */
  readonly headerRow?: number;
}

export interface WorksheetInfo {
  readonly name: string;
  /** Path of the worksheet part in the package. */
  readonly path: string;
  readonly hidden: boolean;
}

/** How a number format shows a number: a date, a date and time, a time of day, a duration. */
type DateKind = 'date' | 'datetime' | 'time' | 'duration';

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function invalid(message: string, hint?: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message, ...(hint ? { hint } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Cell values

const INTEGER = /^-?\d+$/;

/**
 * Whether decimal text is a double's shortest form, so `Number` gives it back digit for digit:
 * no exponent, no leading or trailing zeros, at most 15 significant digits (all a double
 * holds exactly), and not so small that JavaScript would print it with an exponent.
 */
function plainNumber(text: string): boolean {
  const length = text.length;
  let i = text.charCodeAt(0) === 45 ? 1 : 0;
  if (i >= length) return false;
  let digits = 0;
  const first = text.charCodeAt(i);
  if (first === 48) {
    i++;
  } else {
    while (i < length) {
      const c = text.charCodeAt(i);
      if (c < 48 || c > 57) break;
      digits++;
      i++;
    }
    if (digits === 0) return false;
  }
  if (i === length) return digits > 0 && digits <= 15;
  if (text.charCodeAt(i) !== 46 || i === length - 1) return false;
  i++;
  let zeros = 0;
  if (digits === 0) {
    while (i < length && text.charCodeAt(i) === 48) {
      zeros++;
      i++;
    }
    if (zeros >= 6) return false;
  }
  for (; i < length; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    digits++;
  }
  return digits > 0 && digits <= 15 && text.charCodeAt(length - 1) !== 48;
}

/** A `<v>` number as a cell: exact where a JavaScript number is not. */
export function numberCell(text: string): SourceCell {
  const padded = isSpace(text.charCodeAt(0)) || isSpace(text.charCodeAt(text.length - 1));
  const trimmed = padded ? text.trim() : text;
  if (plainNumber(trimmed)) return Number(trimmed);
  const value = Number(trimmed);
  if (trimmed === '' || Number.isNaN(value)) return trimmed === '' ? null : trimmed;
  // Excel writes a double as its shortest round-trip text: that text means that double.
  if (String(value) === trimmed) return value;
  return INTEGER.test(trimmed) ? BigInt(trimmed) : jsonText(trimmed);
}

const BUILTIN_DATE_FORMATS: ReadonlyMap<number, DateKind> = new Map([
  ...[14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 54, 57, 58].map(
    (id) => [id, 'date'] as const,
  ),
  ...[18, 19, 20, 21, 32, 33, 34, 35, 45, 47, 52, 53, 55, 56].map((id) => [id, 'time'] as const),
  [22, 'datetime'] as const,
  [46, 'duration'] as const,
]);

/**
 * What a number format shows a number as: a date, a date and time, a time of day, a duration
 * (`[h]:mm`, elapsed time), or (undefined) a plain number. Quoted text, escapes, fills,
 * colours and locale tags do not count.
 */
export function formatKind(code: string): DateKind | undefined {
  let s = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '');
  s = s.split(';')[0] ?? '';
  const elapsed = /\[(?:h+|m+|s+)\]/i.test(s);
  s = s.replace(/\[[^\]]*\]/g, (tag) => (/^\[(?:h+|m+|s+)\]$/i.test(tag) ? tag.slice(1, -1) : ''));
  if (/^\s*general\s*$/i.test(s)) return undefined;
  s = s.replace(/E[+-]/gi, '').replace(/AM\/PM|A\/P/gi, 'h');
  const time = elapsed || /[hs]/i.test(s);
  const date = /[ydeg]/i.test(s) || (/m/i.test(s) && !time);
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (elapsed) return 'duration';
  return time ? 'time' : undefined;
}

const DAY_MS = 86_400_000;
/** Days from Excel's 1900 epoch (serial 0) to 1970-01-01, past the fake 1900-02-29. */
const UNIX_EPOCH_SERIAL = 25_569;
/** Days between the 1900 and 1904 date systems. */
const DAYS_1904 = 1_462;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function timeText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const millis = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${millis > 0 ? `.${pad(millis, 3)}` : ''}`;
}

/** An Excel serial date as ISO text, per the cell's format and the workbook's date system. */
export function serialToText(serial: number, kind: DateKind, date1904 = false): SourceCell {
  if (!Number.isFinite(serial)) return serial;
  if (kind === 'duration') {
    return serial < 0 ? serial : timeText(Math.round(serial * DAY_MS));
  }
  if (kind === 'time' && serial < 1) {
    return serial < 0 ? serial : timeText(Math.round(serial * DAY_MS) % DAY_MS);
  }
  let days = serial;
  if (date1904) days += DAYS_1904;
  // Excel counts 1900-02-29, which never was: serials before it are one day earlier. Negative
  // serials (Excel has none) count back from 1899-12-30, as openpyxl and pandas write them.
  else if (days >= 0 && days < 61) {
    if (Math.floor(days) === 60) return '1900-02-29';
    days += 1;
  }
  const ms = Math.round((days - UNIX_EPOCH_SERIAL) * DAY_MS);
  const at = new Date(ms);
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() > 9999) return serial;
  const dateText = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const rest = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  // A time format on a value with a date still holds the date: keep it.
  if (kind === 'date' && rest === 0) return dateText;
  return `${dateText} ${timeText(rest)}`;
}

/** A cell as text, for header names and header detection. */
export function cellText(cell: SourceCell): string | null {
  if (cell === null) return null;
  if (typeof cell === 'object') return cell.$json;
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  return String(cell);
}

// ---------------------------------------------------------------------------------------------
// The package

/**
 * Streams an entry's XML into a parser, decoding UTF-8 (or UTF-16 with a byte order mark),
 * and yields after each chunk so the caller can hand on what the handler collected. Stopping
 * the iteration stops the inflation.
 */
async function* parseChunks(
  zip: ZipReader,
  entry: ZipEntry,
  handler: XmlHandler,
  onRead?: (position: number) => void,
): AsyncGenerator<void> {
  const parser = new XmlParser(handler);
  let decoder: InstanceType<typeof TextDecoder> | undefined;
  for await (const chunk of zip.read(entry, onRead)) {
    if (decoder === undefined) {
      const utf16 =
        chunk[0] === 0xff && chunk[1] === 0xfe
          ? 'utf-16le'
          : chunk[0] === 0xfe && chunk[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      decoder = new TextDecoder(utf16);
    }
    parser.push(decoder.decode(chunk, { stream: true }));
    yield;
  }
  if (decoder !== undefined) parser.push(decoder.decode());
  parser.end();
}

async function parseEntry(zip: ZipReader, entry: ZipEntry, handler: XmlHandler): Promise<void> {
  for await (const _chunk of parseChunks(zip, entry, handler)) {
    // The handler collects.
  }
}

/** Resolves a relationship target against the part that holds it. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

interface Relationship {
  readonly type: string;
  readonly target: string;
}

async function readRelationships(zip: ZipReader, part: string): Promise<Map<string, Relationship>> {
  const entry = zip.entry(relsPath(part));
  const rels = new Map<string, Relationship>();
  if (entry === undefined) return rels;
  await parseEntry(zip, entry, {
    open(name, attributes) {
      if (localName(name) !== 'Relationship') return;
      if (attribute(attributes, 'TargetMode') === 'External') return;
      const id = attribute(attributes, 'Id');
      const target = attribute(attributes, 'Target');
      if (id === undefined || target === undefined) return;
      rels.set(id, {
        type: attribute(attributes, 'Type') ?? '',
        target: resolvePart(part, target),
      });
    },
    close() {},
    text() {},
  });
  return rels;
}

/** An open workbook: its worksheets, styles and shared strings. */
export class Workbook {
  private constructor(
    readonly zip: ZipReader,
    readonly sheets: readonly WorksheetInfo[],
    readonly date1904: boolean,
    /** Date kind of each cell style index (undefined: not a date). */
    readonly styleKinds: readonly (DateKind | undefined)[],
    private readonly sharedStringsEntry: ZipEntry | undefined,
  ) {}

  #strings: string[] | undefined;

  /** Opens a workbook from positioned reads of the file; closing the workbook closes them. */
  static async open(reader: RandomAccessReader): Promise<Workbook> {
    let zip: ZipReader | undefined;
    try {
      const head = await reader.read(0, 8);
      if (isCompoundFile(head)) {
        throw invalid(
          'This workbook is encrypted, or in the old .xls format',
          'Save it in Excel as an .xlsx workbook without a password',
        );
      }
      if (!isZip(head)) throw invalid('This is not an Excel .xlsx workbook');
      zip = await ZipReader.open(reader);
      const rootRels = await readRelationships(zip, '');
      const office = [...rootRels.values()].find((rel) => rel.type.endsWith('/officeDocument'));
      const workbookPath = office?.target ?? 'xl/workbook.xml';
      const workbookEntry = zip.entry(workbookPath);
      if (workbookEntry === undefined) throw invalid('The workbook has no workbook part');
      const rels = await readRelationships(zip, workbookPath);
      const listed: { name: string; id: string; hidden: boolean }[] = [];
      let date1904 = false;
      await parseEntry(zip, workbookEntry, {
        open(name, attributes) {
          const local = localName(name);
          if (local === 'workbookPr') {
            const value = attribute(attributes, 'date1904');
            date1904 = value === '1' || value === 'true';
          } else if (local === 'sheet') {
            let id: string | undefined;
            for (let i = 0; i < attributes.length; i += 2) {
              if (attributes[i]!.endsWith(':id')) id = attributes[i + 1];
            }
            const sheetName = attribute(attributes, 'name');
            if (id !== undefined && sheetName !== undefined) {
              const state = attribute(attributes, 'state');
              listed.push({
                name: sheetName,
                id,
                hidden: state === 'hidden' || state === 'veryHidden',
              });
            }
          }
        },
        close() {},
        text() {},
      });
      const sheets: WorksheetInfo[] = listed.flatMap((sheet) => {
        const rel = rels.get(sheet.id);
        if (rel === undefined || !rel.type.endsWith('/worksheet')) return [];
        return [{ name: sheet.name, path: rel.target, hidden: sheet.hidden }];
      });
      const relList = [...rels.values()];
      const stylesPath = relList.find((rel) => rel.type.endsWith('/styles'))?.target;
      const stringsPath = relList.find((rel) => rel.type.endsWith('/sharedStrings'))?.target;
      const styleKinds = stylesPath ? await readStyles(zip, stylesPath) : [];
      const workbook = new Workbook(
        zip,
        sheets,
        date1904,
        styleKinds,
        stringsPath ? zip.entry(stringsPath) : undefined,
      );
      return workbook;
    } catch (error) {
      await (zip ?? reader).close();
      throw error;
    }
  }

  /** The worksheet to read: the named one, else the first visible one. */
  sheet(name?: string): WorksheetInfo {
    if (name !== undefined) {
      const sheet = this.sheets.find((s) => s.name === name);
      if (sheet === undefined) {
        throw new QuerybaraError({
          code: 'NOT_FOUND',
          message: `The workbook has no worksheet "${name}"`,
          hint: `Its worksheets: ${this.sheets.map((s) => s.name).join(', ')}`,
        });
      }
      return sheet;
    }
    const sheet = this.sheets.find((s) => !s.hidden) ?? this.sheets[0];
    if (sheet === undefined) throw invalid('The workbook has no worksheets');
    return sheet;
  }

  /** The shared string table, read once. */
  async sharedStrings(): Promise<readonly string[]> {
    if (this.#strings !== undefined) return this.#strings;
    const strings: string[] = [];
    const entry = this.sharedStringsEntry;
    if (entry !== undefined) {
      let current = '';
      let inItem = false;
      let inText = false;
      let phonetic = 0;
      await parseEntry(this.zip, entry, {
        open(name) {
          const local = localName(name);
          if (local === 'si') {
            inItem = true;
            current = '';
          } else if (local === 'rPh') phonetic++;
          else if (local === 't' && inItem && phonetic === 0) inText = true;
        },
        close(name) {
          const local = localName(name);
          if (local === 'si') {
            strings.push(decodeHexEscapes(current));
            inItem = false;
          } else if (local === 'rPh') phonetic--;
          else if (local === 't') inText = false;
        },
        text(text) {
          if (inText) current += text;
        },
      });
    }
    this.#strings = strings;
    return strings;
  }

  close(): Promise<void> {
    return this.zip.close();
  }
}

async function readStyles(zip: ZipReader, path: string): Promise<(DateKind | undefined)[]> {
  const entry = zip.entry(path);
  if (entry === undefined) return [];
  const custom = new Map<number, string>();
  const xfs: number[] = [];
  let inCellXfs = false;
  await parseEntry(zip, entry, {
    open(name, attributes) {
      const local = localName(name);
      if (local === 'numFmt') {
        const id = Number(attribute(attributes, 'numFmtId'));
        const code = attribute(attributes, 'formatCode');
        if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
      } else if (local === 'cellXfs') inCellXfs = true;
      else if (local === 'xf' && inCellXfs)
        xfs.push(Number(attribute(attributes, 'numFmtId') ?? 0));
    },
    close(name) {
      if (localName(name) === 'cellXfs') inCellXfs = false;
    },
    text() {},
  });
  return xfs.map((id) => {
    const code = custom.get(id);
    return code !== undefined ? formatKind(code) : BUILTIN_DATE_FORMATS.get(id);
  });
}

// ---------------------------------------------------------------------------------------------
// Worksheet rows

/** One worksheet row as parsed: its row number and cells by column index. */
export interface SheetRow {
  readonly row: number;
  readonly cells: SourceCell[];
}

/** Columns a worksheet can have (A to XFD). */
const LAST_COLUMN = 16_384;

/** Column index (0-based) of a cell reference such as `AB12`, or -1. */
export function columnIndex(ref: string): number {
  let index = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) index = index * 26 + (c - 64);
    else if (c >= 97 && c <= 122) index = index * 26 + (c - 96);
    else break;
  }
  return i === 0 ? -1 : index - 1;
}

/** Parses worksheet XML into rows; `onRow` hears each row that has at least one value. */
class SheetHandler implements XmlHandler {
  private inData = false;
  private row = 0;
  private cells: SourceCell[] = [];
  private filled = false;
  private column = -1;
  private type: string | undefined;
  private style = 0;
  private hasValue = false;
  private buffer = '';
  /** 1: inside <v>; 2: inside <is> <t>; 0: elsewhere. */
  private capture = 0;
  private inInline = false;
  private phonetic = 0;

  constructor(
    private readonly strings: readonly string[],
    private readonly styleKinds: readonly (DateKind | undefined)[],
    private readonly date1904: boolean,
    private readonly onRow: (row: SheetRow) => void,
  ) {}

  open(name: string, attributes: string[]): void {
    const local = name.indexOf(':') < 0 ? name : localName(name);
    switch (local) {
      case 'c': {
        if (!this.inData) return;
        let at = -1;
        this.type = undefined;
        this.style = 0;
        for (let i = 0; i < attributes.length; i += 2) {
          const attr = attributes[i];
          if (attr === 'r') at = columnIndex(attributes[i + 1]!);
          else if (attr === 't') this.type = attributes[i + 1];
          else if (attr === 's') this.style = Number(attributes[i + 1]);
        }
        this.column = at >= 0 ? at : this.column + 1;
        if (this.column >= LAST_COLUMN) {
          throw invalid(`Row ${this.row} has a cell past Excel's last column (XFD)`);
        }
        this.hasValue = false;
        this.buffer = '';
        return;
      }
      case 'v':
        if (this.inData) {
          this.capture = 1;
          this.hasValue = true;
        }
        return;
      case 'is':
        if (this.inData) {
          this.inInline = true;
          this.hasValue = true;
        }
        return;
      case 't':
        if (this.inInline && this.phonetic === 0) this.capture = 2;
        return;
      case 'rPh':
        this.phonetic++;
        return;
      case 'row': {
        if (!this.inData) return;
        const r = Number(attribute(attributes, 'r'));
        this.row = Number.isInteger(r) && r > 0 ? r : this.row + 1;
        this.cells = [];
        this.filled = false;
        this.column = -1;
        return;
      }
      case 'sheetData':
        this.inData = true;
        return;
    }
  }

  close(name: string): void {
    const local = name.indexOf(':') < 0 ? name : localName(name);
    switch (local) {
      case 'v':
      case 't':
        this.capture = 0;
        return;
      case 'is':
        this.inInline = false;
        return;
      case 'rPh':
        this.phonetic--;
        return;
      case 'c': {
        if (!this.inData || !this.hasValue) return;
        const value = this.value();
        if (value !== null) {
          this.cells[this.column] = value;
          this.filled = true;
        }
        return;
      }
      case 'row':
        if (this.inData && this.filled) {
          for (let c = 0; c < this.cells.length; c++) this.cells[c] ??= null;
          this.onRow({ row: this.row, cells: this.cells });
        }
        return;
      case 'sheetData':
        this.inData = false;
        return;
    }
  }

  text(text: string): void {
    if (this.capture !== 0) this.buffer += text;
  }

  private value(): SourceCell {
    const text = this.buffer;
    switch (this.type) {
      case 's': {
        const index = Number(text);
        const value = this.strings[index];
        if (value === undefined) {
          throw invalid(
            `Cell ${columnName(this.column)}${this.row} points to shared string ${text}, which does not exist`,
          );
        }
        return value;
      }
      case 'inlineStr':
      case 'str':
        return decodeHexEscapes(text);
      case 'b':
        return text.trim() === '1' || text.trim().toLowerCase() === 'true';
      case 'e':
        return null;
      case 'd':
        return text.trim() === '' ? null : text.trim();
      default: {
        const value = numberCell(text);
        const kind = this.styleKinds[this.style];
        if (kind === undefined || value === null) return value;
        const serial = typeof value === 'number' ? value : Number(cellText(value));
        return serialToText(serial, kind, this.date1904);
      }
    }
  }
}

/** Excel's column name for a 0-based index: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * Turns worksheet rows into data rows: skips rows above the header row, names the columns
 * from it (blank names become `columnN`, duplicates are suffixed) and numbers the rest. The
 * worksheet row number is kept as each row's line.
 */
export class XlsxRowBuilder {
  columns: string[] = [];
  private row = 0;
  private headerDone: boolean;

  constructor(private readonly headerRow: number | undefined) {
    this.headerDone = headerRow === 0;
  }

  add(sheetRow: SheetRow, parts: BatchParts): void {
    if (!this.headerDone) {
      const target = this.headerRow;
      if (target !== undefined && sheetRow.row < target) return;
      this.headerDone = true;
      if (target === undefined || sheetRow.row === target) {
        this.columns = headerNames(sheetRow.cells.map(cellText));
        return;
      }
    }
    const cells = sheetRow.cells;
    if (cells.length > this.columns.length) this.columns = widen(this.columns, cells.length);
    while (cells.length < this.columns.length) cells.push(null);
    parts.rows.push(cells);
    parts.rowNumbers.push(++this.row);
    parts.lines.push(sheetRow.row);
  }
}

/**
 * Opens a source as a workbook: positioned reads of a file or buffer, else (stdin, gzip) a
 * spooled copy.
 */
export async function openWorkbook(
  source: ByteSource,
  decompress: 'auto' | 'gzip' | 'none' = 'auto',
): Promise<Workbook> {
  if (source.randomAccess !== undefined && decompress !== 'gzip') {
    const reader = await source.randomAccess();
    const head = await reader.read(0, 2);
    if (decompress === 'none' || !isGzip(head)) return Workbook.open(reader);
    await reader.close();
  }
  let bytes = source;
  if (decompress !== 'none') {
    const peeked = await peekSource(source, 2);
    bytes = decompress === 'gzip' || isGzip(peeked.head) ? gunzip(peeked.source) : peeked.source;
  }
  return Workbook.open(await randomAccess(bytes));
}

/**
 * Streams the rows of one worksheet into `onRow` (every row with a value), yielding after
 * each chunk of the sheet so the caller can pass rows on in batches or stop early.
 */
export async function* readSheet(
  workbook: Workbook,
  sheet: WorksheetInfo,
  onRow: (row: SheetRow) => void,
  onRead?: (position: number) => void,
): AsyncGenerator<void> {
  const entry = workbook.zip.entry(sheet.path);
  if (entry === undefined) throw invalid(`The worksheet "${sheet.name}" is missing from the file`);
  const strings = await workbook.sharedStrings();
  const handler = new SheetHandler(strings, workbook.styleKinds, workbook.date1904, onRow);
  yield* parseChunks(workbook.zip, entry, handler, onRead);
}
