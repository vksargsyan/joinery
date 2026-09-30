import { JoineryError, type CellValue, type ColumnKind, type ColumnMeta } from '@joinery/core';

import type { Sink } from './io';
import { columnName } from './xlsx-read';
import { escapeXmlAttribute, escapeXmlText } from './xml';
import { ZipWriter } from './zip';

/**
 * Excel workbooks written as streams (spec §12). Each worksheet is a ZIP entry deflated as its
 * rows arrive, with inline strings rather than a shared string table, so nothing but the
 * current page is held; the workbook parts that list the sheets are written last.
 *
 * Cells are typed from the result's column kinds: numbers and booleans as such; dates,
 * timestamps and times as real Excel dates (serial numbers with a date format; timestamps in
 * the wall-clock time the server wrote, since Excel has no time zones); integers beyond 2^53
 * and decimals as text, so no digit is lost (with `decimals: 'number'`, decimals a double
 * holds exactly — up to 15 significant digits — become numbers); what Excel cannot hold
 * exactly stays text: dates before 1900-03-01 or infinite, times past 24 hours, and
 * fractions of a second finer than milliseconds; binary as hex text. The header row
 * is bold on a tinted fill, frozen, with an autofilter, and columns are sized from the header
 * and the first page. A result longer than a worksheet (1,048,576 rows) continues on
 * `name (2)`, `name (3)`... with the header repeated.
 */

export interface XlsxExportOptions {
  /** Write a header row with the column names (default true). */
  readonly header?: boolean;
  /** `text` (default) keeps decimals' exact digits; `number` writes exact ones as numbers. */
  readonly decimals?: 'text' | 'number';
  /** Binary cells: `hex` (`\x0102`, the default) or `base64`. */
  readonly binary?: 'hex' | 'base64';
  /** Rows per worksheet, header included, before a result goes on (default and most 1,048,576). */
  readonly rowsPerSheet?: number;
}

/** Rows a worksheet holds, header included. */
export const XLSX_MAX_ROWS = 1_048_576;
/** Columns a worksheet holds. */
export const XLSX_MAX_COLUMNS = 16_384;

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Cell styles (indexes into cellXfs in styles.xml). */
const STYLE = { header: 1, date: 2, datetime: 3, datetimeMs: 4, time: 5, timeMs: 6 } as const;

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">
<numFmts count="5"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss.000"/><numFmt numFmtId="167" formatCode="hh:mm:ss"/><numFmt numFmtId="168" formatCode="hh:mm:ss.000"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDE4EE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF8497B0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
`;

// ---------------------------------------------------------------------------------------------
// Cell values

const DAY_MS = 86_400_000;
const UNIX_EPOCH_SERIAL = 25_569;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}(?::?\d{2}){0,2})?$/i;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?(\d+)(?:\.(\d+))?$/;

/** Excel's serial day of a date, for dates it can show (1900-03-01 to 9999-12-31). */
function serialDay(year: number, month: number, day: number): number | undefined {
  if (year < 1900 || year > 9999 || (year === 1900 && month < 3)) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const at = new Date(ms);
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return undefined;
  return ms / DAY_MS + UNIX_EPOCH_SERIAL;
}

/**
 * Milliseconds in a fraction of a second, or undefined when it has more precision than that
 * (Excel keeps milliseconds; such a value stays text so no digit is lost).
 */
function fractionMs(fraction: string | undefined): number | undefined {
  if (fraction === undefined) return 0;
  if (/[1-9]/.test(fraction.slice(3))) return undefined;
  return Number(fraction.slice(0, 3).padEnd(3, '0'));
}

function dayFraction(h: string, m: string, s: string, ms: number): number {
  return (Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + ms) / DAY_MS;
}

/**
 * A date, timestamp or time as an Excel serial number and style, if Excel holds it exactly:
 * a date from 1900-03-01 to 9999-12-31, a time of day, to the millisecond.
 */
export function excelDate(
  text: string,
  kind: 'date' | 'datetime' | 'time',
): { serial: number; style: number } | undefined {
  if (kind === 'time') {
    const m = TIME_RE.exec(text);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return undefined;
    const ms = fractionMs(m[4]);
    if (ms === undefined) return undefined;
    return {
      serial: dayFraction(m[1]!, m[2]!, m[3]!, ms),
      style: ms > 0 ? STYLE.timeMs : STYLE.time,
    };
  }
  const date = DATE_RE.exec(text);
  if (date) {
    const day = serialDay(Number(date[1]), Number(date[2]), Number(date[3]));
    return day === undefined ? undefined : { serial: day, style: STYLE.date };
  }
  const m = DATETIME_RE.exec(text);
  if (!m || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return undefined;
  const day = serialDay(Number(m[1]), Number(m[2]), Number(m[3]));
  const ms = fractionMs(m[7]);
  if (day === undefined || ms === undefined) return undefined;
  return {
    serial: day + dayFraction(m[4]!, m[5]!, m[6]!, ms),
    style: ms > 0 ? STYLE.datetimeMs : STYLE.datetime,
  };
}

/** Decimal text a double holds exactly (15 significant digits or fewer), as that double. */
export function exactDecimal(text: string): number | undefined {
  const m = DECIMAL_RE.exec(text);
  if (!m) return undefined;
  const digits = `${m[1]!}${m[2] ?? ''}`.replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 15) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) < 1e300 ? value : undefined;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function binaryText(bytes: Uint8Array, binary: 'hex' | 'base64'): string {
  if (binary === 'base64') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

function numberXml(ref: string, value: number, style = 0): string {
  const text = Object.is(value, -0) ? '0' : String(value);
  return `<c r="${ref}"${style > 0 ? ` s="${style}"` : ''}><v>${text}</v></c>`;
}

function textXml(ref: string, text: string, style = 0): string {
  const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style > 0 ? ` s="${style}"` : ''} t="inlineStr"><is><t${space}>${escapeXmlText(text, true)}</t></is></c>`;
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** One cell's XML (empty for NULL). */
function cellXml(
  ref: string,
  value: CellValue,
  kind: ColumnKind,
  options: XlsxExportOptions,
): string {
  if (value === null) return '';
  switch (typeof value) {
    case 'boolean':
      return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    case 'number':
      return Number.isFinite(value) ? numberXml(ref, value) : textXml(ref, String(value));
    case 'bigint':
      return value >= -SAFE && value <= SAFE
        ? numberXml(ref, Number(value))
        : textXml(ref, value.toString());
    case 'string': {
      switch (kind) {
        case 'integer':
        case 'bigint':
          if (INTEGER_RE.test(value) && Number.isSafeInteger(Number(value))) {
            return numberXml(ref, Number(value));
          }
          break;
        case 'decimal':
          if (options.decimals === 'number') {
            const exact = exactDecimal(value);
            if (exact !== undefined) return numberXml(ref, exact);
          }
          break;
        case 'date':
        case 'datetime':
        case 'timestamp':
        case 'time': {
          const date = excelDate(value, kind === 'timestamp' ? 'datetime' : kind);
          if (date !== undefined) return numberXml(ref, date.serial, date.style);
          break;
        }
        default:
          break;
      }
      return textXml(ref, value);
    }
    default:
      if (value instanceof Uint8Array)
        return textXml(ref, binaryText(value, options.binary ?? 'hex'));
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: 'A large value was only previewed; fetch it in full before exporting',
      });
  }
}

/** A cell's width in characters, for sizing columns from a sample. */
function cellWidth(value: CellValue, kind: ColumnKind): number {
  if (value === null) return 0;
  if (kind === 'date') return 10;
  if (kind === 'datetime' || kind === 'timestamp') return 19;
  if (typeof value === 'string') {
    const line = value.indexOf('\n');
    return line < 0 ? value.length : line;
  }
  if (value instanceof Uint8Array) return value.length * 2 + 2;
  return String(value).length;
}

/**
 * A worksheet name Excel accepts: no `[]:*?/\`, no leading or trailing `'`, at most 31
 * characters, not "History", unique in the workbook (case-insensitive).
 */
export function sheetName(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .replace(/[[\]:*?/\\]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim();
  if (base === '') base = 'Sheet';
  if (base.toLowerCase() === 'history') base = 'History_';
  base = [...base].slice(0, 31).join('');
  let unique = base;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    unique = [...base].slice(0, 31 - suffix.length).join('') + suffix;
  }
  return unique;
}

// ---------------------------------------------------------------------------------------------
// Workbook

interface SheetEntry {
  readonly name: string;
  readonly path: string;
  /** `A1:D10` when the sheet has a header and so an autofilter. */
  filter?: string;
}

/** Streams one result into worksheets of the workbook (see the module comment). */
export class XlsxSheetWriter {
  private columns: readonly ColumnMeta[] = [];
  private letters: string[] = [];
  private sink: Sink | undefined;
  private entry: SheetEntry | undefined;
  private row = 0;
  private part = 0;
  private readonly encoder = new TextEncoder();
  private readonly limit: number;

  constructor(
    private readonly book: XlsxWorkbookWriter,
    private readonly name: string,
    private readonly options: XlsxExportOptions,
  ) {
    this.limit = Math.min(
      XLSX_MAX_ROWS,
      Math.max(2, Math.floor(options.rowsPerSheet ?? XLSX_MAX_ROWS)),
    );
  }

  private async write(text: string): Promise<void> {
    if (text.length > 0) await this.sink!.write(this.encoder.encode(text));
  }

  begin(columns: readonly ColumnMeta[]): void {
    if (columns.length > XLSX_MAX_COLUMNS) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: `${columns.length} columns do not fit in an Excel worksheet (at most ${XLSX_MAX_COLUMNS})`,
      });
    }
    this.columns = columns;
    this.letters = columns.map((_c, i) => columnName(i));
  }

  /** Opens the next worksheet part: prologue, column widths and the header row. */
  private async open(sample: readonly (readonly CellValue[])[]): Promise<void> {
    this.part++;
    const header = this.options.header !== false;
    const name = this.part === 1 ? this.name : `${this.name} (${this.part})`;
    const opened = this.book.addSheet(name);
    this.entry = opened.entry;
    this.sink = opened.sink;
    this.row = 0;
    const widths = this.columns.map((column, c) => {
      let width = header ? column.name.length + 2 : 0;
      for (let r = 0; r < Math.min(sample.length, 200); r++) {
        width = Math.max(width, cellWidth(sample[r]![c] ?? null, column.kind));
      }
      return Math.min(60, Math.max(8, width + 2));
    });
    let out = `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`;
    if (header && this.columns.length > 0) {
      out +=
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    }
    out += '<sheetFormatPr defaultRowHeight="15"/>';
    if (widths.length > 0) {
      out += `<cols>${widths
        .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
        .join('')}</cols>`;
    }
    out += '<sheetData>';
    if (header && this.columns.length > 0) {
      this.row = 1;
      out += `<row r="1">${this.columns
        .map((column, c) => textXml(`${this.letters[c]!}1`, column.name, STYLE.header))
        .join('')}</row>`;
    }
    await this.write(out);
  }

  /** Closes the current worksheet part. */
  private async close(): Promise<void> {
    const header = this.options.header !== false && this.columns.length > 0;
    let out = '</sheetData>';
    if (header) {
      const range = `A1:${this.letters[this.letters.length - 1]!}${Math.max(1, this.row)}`;
      out += `<autoFilter ref="${range}"/>`;
      this.entry!.filter = range;
    }
    out += '</worksheet>';
    await this.write(out);
    await this.sink!.close();
    this.sink = undefined;
  }

  /** Writes a page of rows (`data[column][row]`, as result chunks hold them). */
  async page(data: readonly (readonly CellValue[])[], rowCount: number): Promise<void> {
    if (rowCount === 0) return;
    const width = this.columns.length;
    const rows = (from: number, to: number): CellValue[][] => {
      const out: CellValue[][] = [];
      for (let r = from; r < to; r++) {
        const row: CellValue[] = new Array<CellValue>(width);
        for (let c = 0; c < width; c++) row[c] = data[c]![r] ?? null;
        out.push(row);
      }
      return out;
    };
    let r = 0;
    while (r < rowCount) {
      if (this.sink === undefined) await this.open(rows(r, Math.min(rowCount, r + 200)));
      const room = this.limit - this.row;
      const take = Math.min(room, rowCount - r);
      let out = '';
      for (let i = r; i < r + take; i++) {
        const n = ++this.row;
        let cells = '';
        for (let c = 0; c < width; c++) {
          cells += cellXml(
            `${this.letters[c]!}${n}`,
            data[c]![i] ?? null,
            this.columns[c]!.kind,
            this.options,
          );
        }
        out += `<row r="${n}">${cells}</row>`;
      }
      await this.write(out);
      r += take;
      if (this.row >= this.limit) await this.close();
    }
  }

  /** Finishes the result: an empty result still gets its sheet with the header. */
  async end(): Promise<void> {
    if (this.sink === undefined && this.part === 0) await this.open([]);
    if (this.sink !== undefined) await this.close();
  }
}

/** The workbook: a ZIP of worksheets, then the parts that list them. */
export class XlsxWorkbookWriter {
  private readonly zip: ZipWriter;
  private readonly sheets: SheetEntry[] = [];
  private readonly taken = new Set<string>();

  constructor(sink: Sink) {
    this.zip = new ZipWriter(sink);
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.zip.bytes;
  }

  /** A writer for one result, on a worksheet named after it (made valid and unique). */
  sheet(name: string, options: XlsxExportOptions = {}): XlsxSheetWriter {
    return new XlsxSheetWriter(this, name, options);
  }

  /** Starts a worksheet part; used by the sheet writers. */
  addSheet(name: string): { entry: SheetEntry; sink: Sink } {
    const unique = sheetName(name, this.taken);
    this.taken.add(unique.toLowerCase());
    const entry: SheetEntry = {
      name: unique,
      path: `xl/worksheets/sheet${this.sheets.length + 1}.xml`,
    };
    this.sheets.push(entry);
    return { entry, sink: this.zip.entry(entry.path) };
  }

  private async part(path: string, text: string): Promise<void> {
    const sink = this.zip.entry(path);
    await sink.write(new TextEncoder().encode(text));
    await sink.close();
  }

  /** Writes the workbook parts and closes the file. */
  async close(): Promise<void> {
    if (this.sheets.length === 0) {
      // Excel needs a worksheet.
      const { sink } = this.addSheet('Sheet1');
      await sink.write(
        new TextEncoder().encode(
          `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData/></worksheet>`,
        ),
      );
      await sink.close();
    }
    const sheets = this.sheets;
    const quoted = (name: string): string => `'${name.replace(/'/g, "''")}'`;
    const filters = sheets.flatMap((sheet, i) =>
      sheet.filter === undefined
        ? []
        : [
            `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXmlText(
              `${quoted(sheet.name)}!${sheet.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`,
            )}</definedName>`,
          ],
    );
    await this.part(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>${sheets
        .map(
          (sheet, i) =>
            `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
        )
        .join(
          '',
        )}</sheets>${filters.length > 0 ? `<definedNames>${filters.join('')}</definedNames>` : ''}</workbook>`,
    );
    await this.part(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${sheets
        .map(
          (sheet, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="${sheet.path.slice(3)}"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    );
    await this.part('xl/styles.xml', STYLES_XML);
    await this.part(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    );
    await this.part(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map(
          (sheet) =>
            `<Override PartName="/${sheet.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')}</Types>`,
    );
    await this.zip.close();
  }

  /** Abandons the workbook (a file sink removes its file). */
  abort(reason?: unknown): Promise<void> {
    return this.zip.abort(reason);
  }
}
