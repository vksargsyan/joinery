# 0012. Excel, XML and ZIP written in `@joinery/transfer` on node:zlib, with no library

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §12 lists Excel (.xlsx, streamed) and XML imports, and Excel, XML, HTML and Markdown
exports with optional zip output. Everything in `@joinery/transfer` streams with backpressure
([ADR 0006](0006-job-runner-process.md)): memory must stay flat whatever the file size, and a
200,000-row workbook must import with well under 200 MB of RSS growth.

An .xlsx workbook is a ZIP of XML parts. Reading one needs random access (the ZIP's directory is
at its end, and the shared string table and styles must be read before the worksheet), a
streaming inflate, and a streaming XML parser; writing one needs a streaming ZIP writer and
XML escaping. The candidates:

- **SheetJS (xlsx)** reads whole workbooks into memory; its streaming writer is limited, and
  current releases are no longer published to npm.
- **ExcelJS** has streaming reader and writer classes, but pulls in a dozen dependencies
  (archiver, unzipper, sax, saxes...), keeps shared strings and styles in its own object model,
  converts dates to `Date` objects in the local time zone, and numbers to doubles, losing
  bigints and exact decimals.
- **yauzl/yazl + saxes**: small and maintained, but three dependencies for what node:zlib
  (raw deflate, inflate and `crc32` since Node.js 22.2) already provides, and saxes is slower
  than a parser built for exactly the tokens a data file uses.

## Decision

**Write the three pieces in `@joinery/transfer`, on node:zlib alone.**

- `zip.ts`: `ZipReader` reads the central directory (ZIP64 included) from a `RandomAccessReader`
  and streams one entry at a time through raw inflate, checking size and CRC-32; `ZipWriter`
  deflates entries into a Sink one after another with data descriptors, adding ZIP64 records
  only when the archive needs them.
- `xml.ts`: a SAX-style parser that takes text in chunks split anywhere, checks
  well-formedness, reports lines, and never expands DTD entities or fetches anything (no XXE,
  no entity bombs). It parses about 45 MB of worksheet XML a second.
- `xlsx-read.ts` / `xlsx-write.ts` on top: shared strings, styles (to tell dates from numbers),
  the 1900 and 1904 date systems, inline strings, OOXML `_xHHHH_` escapes; worksheets written
  with inline strings so the writer holds nothing but the current page.

Sources gain an optional `randomAccess()` (files and in-memory bytes have one); anything else
(stdin, gzip) is spooled to a temporary file first. XML import picks rows by a path from the
root, detected from a sample; the XML export shape (`<export>`, `<table name>`, `<row>`,
SQL/XML element names, `xsi:nil` for NULL) is documented in `exportRows` and stays stable.

## Consequences

- No new dependency in the client, the CLI bundle or the licence audit; the code is ours to fix
  and is covered by round-trip, fuzz and interoperability tests (a workbook written by openpyxl,
  a ZIP written by Python; our workbooks read by openpyxl).
- Values stay exact: integers beyond 2^53 and decimals are text in exported workbooks (numbers
  on request when a double holds them), timestamps finer than a millisecond stay text, and the
  reader returns numbers a double does not print digit for digit as their exact text.
- Streaming is proven by a test: 200,000 rows read with about 20 MB of RSS growth.
- The xlsx reader holds the shared string table in memory, as every xlsx reader must; a
  workbook of millions of distinct strings costs memory in proportion. Legacy .xls and
  password-protected workbooks (OLE compound files) are refused with a clear message.
- Features outside data transfer (formulas, charts, rich formatting, encryption) are out of
  scope; a library could still be adopted behind the same reader and writer if they are needed.
