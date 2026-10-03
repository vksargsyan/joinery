import type { CellValue, ColumnKind, ColumnMeta } from '@querybara/core';

import {
  ZipReader,
  ZipWriter,
  bytesSource,
  fileSink,
  memoryReader,
  memorySink,
  readRows,
  type ReadOptions,
  type RowBatch,
  type SourceCell,
} from '../src';

/** Helpers for the workbook tests: build workbooks by hand, read rows back, peek at parts. */

export const col = (name: string, kind: ColumnKind, nativeType: string = kind): ColumnMeta => ({
  name,
  kind,
  nativeType,
});

/**
 * Writes a large workbook the way Excel does (every text in the shared string table, dates as
 * styled serials), streamed so the test's own memory stays flat: `rows` rows of id, name
 * (unique, shared), city (repeated, shared), amount, ratio, active, day, stamp. Returns the
 * uncompressed size of the worksheet XML.
 */
export async function writeLargeWorkbook(path: string, rows: number): Promise<number> {
  const zip = new ZipWriter(fileSink(path), { level: 1 });
  const encoder = new TextEncoder();
  const add = async (name: string, chunks: Iterable<string>): Promise<number> => {
    const entry = zip.entry(name);
    let size = 0;
    for (const chunk of chunks) {
      const bytes = encoder.encode(chunk);
      size += bytes.length;
      await entry.write(bytes);
    }
    await entry.close();
    return size;
  };
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const cities = ['Paris', 'Oslo', 'Lima', 'Pune', 'Kyiv', 'Perth', 'Quito', 'Riga'];
  const header = ['id', 'name', 'city', 'amount', 'ratio', 'active', 'day', 'stamp'];
  // Shared strings: the header, the cities, then one name per row.
  const strings = function* (): Generator<string> {
    yield `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}">`;
    for (const text of [...header, ...cities]) yield `<si><t>${text}</t></si>`;
    for (let r = 0; r < rows; r += 1000) {
      let out = '';
      for (let i = r; i < Math.min(rows, r + 1000); i++)
        out += `<si><t>Customer ${i} &amp; Sons</t></si>`;
      yield out;
    }
    yield '</sst>';
  };
  const sheet = function* (): Generator<string> {
    yield `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>`;
    yield `<row r="1">${header.map((_h, c) => `<c r="${String.fromCharCode(65 + c)}1" t="s"><v>${c}</v></c>`).join('')}</row>`;
    const base = header.length + cities.length;
    for (let r = 0; r < rows; r += 1000) {
      let out = '';
      for (let i = r; i < Math.min(rows, r + 1000); i++) {
        const n = i + 2;
        out +=
          `<row r="${n}"><c r="A${n}"><v>${i + 1}</v></c><c r="B${n}" t="s"><v>${base + i}</v></c>` +
          `<c r="C${n}" t="s"><v>${header.length + (i % cities.length)}</v></c><c r="D${n}"><v>${(i * 7) % 100000}.25</v></c>` +
          `<c r="E${n}"><v>${(i % 1000) / 1000}</v></c><c r="F${n}" t="b"><v>${i % 2}</v></c>` +
          `<c r="G${n}" s="1"><v>${45000 + (i % 3650)}</v></c><c r="H${n}" s="2"><v>${45000 + (i % 3650) + 0.5}</v></c></row>`;
      }
      yield out;
    }
    yield '</sheetData></worksheet>';
  };
  await add('[Content_Types].xml', [
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  ]);
  await add('_rels/.rels', [
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  ]);
  await add('xl/workbook.xml', [
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  ]);
  await add('xl/_rels/workbook.xml.rels', [
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  ]);
  await add('xl/styles.xml', [
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
  ]);
  await add('xl/sharedStrings.xml', strings());
  const size = await add('xl/worksheets/sheet1.xml', sheet());
  await zip.close();
  return size;
}

/** Rows as a result chunk holds them: `data[column][row]`. */
export function columnar(rows: readonly (readonly CellValue[])[], width: number): CellValue[][] {
  return Array.from({ length: width }, (_, c) => rows.map((row) => row[c] ?? null));
}

/** Every row of a source, with the final columns and each row's line. */
export async function readAll(
  source: Uint8Array | string,
  options: ReadOptions,
  chunkSize?: number,
): Promise<{ columns: string[]; rows: SourceCell[][]; lines: number[]; batches: RowBatch[] }> {
  const rows: SourceCell[][] = [];
  const lines: number[] = [];
  const batches: RowBatch[] = [];
  let columns: string[] = [];
  for await (const batch of readRows(bytesSource(source, chunkSize), options)) {
    batches.push(batch);
    columns = [...batch.columns];
    batch.rows.forEach((row, i) => {
      rows.push([
        ...row,
        ...new Array<SourceCell>(Math.max(0, columns.length - row.length)).fill(null),
      ]);
      lines.push(batch.lines[i]!);
    });
  }
  return { columns, rows: rows.map((row) => row.slice(0, columns.length)), lines, batches };
}

/** The text of one part of a ZIP held in memory. */
export async function partText(zip: Uint8Array, name: string): Promise<string> {
  const reader = await ZipReader.open(memoryReader(zip));
  const entry = reader.entry(name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return reader.text(entry);
}

export interface RawSheet {
  readonly name: string;
  readonly xml: string;
  readonly state?: 'hidden';
}

/**
 * A workbook assembled from raw parts, the way Excel lays one out (shared strings, styles,
 * relationships), for reader tests that must not depend on Querybara's own writer.
 */
export async function rawWorkbook(options: {
  sheets: readonly RawSheet[];
  sharedStrings?: string;
  styles?: string;
  date1904?: boolean;
}): Promise<Uint8Array> {
  const sink = memorySink();
  const zip = new ZipWriter(sink);
  const add = async (name: string, text: string): Promise<void> => {
    const entry = zip.entry(name);
    await entry.write(new TextEncoder().encode(text));
    await entry.close();
  };
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  await add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  await add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const sheets = options.sheets;
  await add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="${rel}">${
      options.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'
    }<sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name.replace(/&/g, '&amp;')}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
  );
  const extra = sheets.length;
  await add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}<Relationship Id="rId${extra + 1}" Type="${rel}/styles" Target="styles.xml"/>${
      options.sharedStrings !== undefined
        ? `<Relationship Id="rId${extra + 2}" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>`
        : ''
    }</Relationships>`,
  );
  await add(
    'xl/styles.xml',
    options.styles ??
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
  );
  if (options.sharedStrings !== undefined) {
    await add(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}">${options.sharedStrings}</sst>`,
    );
  }
  for (const [i, sheet] of sheets.entries()) {
    await add(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${sheet.xml}</sheetData></worksheet>`,
    );
  }
  await zip.close();
  return sink.bytes();
}
