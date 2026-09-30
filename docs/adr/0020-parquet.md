# 0020. Parquet on hyparquet and hyparquet-writer, streamed by row group

- Status: Accepted
- Date: 2026-09-30

## Context

Parquet is how analytics tools exchange tables: DuckDB, Spark, pandas, Polars, BigQuery,
Snowflake and every data lake read and write it. Joinery's import and export ([ADR 0012](0012-excel-xml-zip-formats.md))
had no columnar format, so data headed there went through CSV and lost its types.

A Parquet file is column chunks in row groups, described by a footer at the end of the file in
Thrift's compact protocol. Reading one needs:

- the Thrift decoder;
- the page encodings: plain, dictionary, RLE and bit-packed levels, and the delta encodings;
- Dremel's repetition and definition levels for lists, maps and structs;
- the codecs: Snappy, GZIP, ZSTD, Brotli, LZ4.

Writing needs the inverse of most of that, plus statistics and page indexes. That is several
thousand lines of format code, where ADR 0012's pieces (ZIP, a SAX parser, xlsx parts) were
each a few hundred.

The candidates:

- **Writing it ourselves** on node:zlib, as ADR 0012 did. zlib covers GZIP, Brotli and (since
  Node.js 22.15) ZSTD, but Snappy, Thrift, the encodings and Dremel would all be new code to
  get right against many writers.
- **parquet-wasm** (Arrow's Rust implementation in WebAssembly): complete and fast. But it adds
  a 5 MB WASM module to the job runner and the CLI, needs Arrow tables in memory, and goes
  through Arrow IPC to reach JavaScript values.
- **@dsnp/parquetjs**: a maintained fork of parquetjs. It brings a dozen dependencies (thrift,
  brotli, lzo, snappy bindings among them), has row-based writing only, and has not kept up
  with logical types.
- **hyparquet** and **hyparquet-writer** (Hyperparam, MIT): pure JavaScript, no dependencies
  beyond each other.
  - The reader reads any row range through positioned reads, skipping the pages before it.
  - The writer takes columns a row group at a time.
  - Snappy is built in, and other codecs plug in.
  - Both cover the logical types: DECIMAL, DATE, TIME, TIMESTAMP, UUID, JSON, FLOAT16, INTEGER,
    GEOMETRY and VARIANT.

## Decision

**Parquet is read and written with hyparquet 1.31.1 and hyparquet-writer 0.16.10, in
`@joinery/transfer`'s `parquet.ts`.**

The libraries own the file format. `parquet.ts` owns four things:

- **Values, exactly.** Top-level primitive columns are read with their annotations stripped and
  converted in `parquet.ts`. hyparquet's own conversions turn decimals into doubles and
  timestamps into millisecond `Date`s, so ours are used instead:
  - decimals become exact text;
  - dates become `YYYY-MM-DD`, with BC and five-digit years;
  - times and timestamps keep every microsecond or nanosecond, with `Z` when UTC-adjusted;
  - unsigned integers are widened;
  - binary becomes `\x` hex, UUIDs their text, geometry hex WKB;
  - INT96 is read as Spark and Impala write it.

  Nested columns (lists, maps, structs, variants) become JSON text, with bigints as digits.
  Writing maps the result's column kinds, using the engine's type name:
  - integers become INT32 or INT64, and MySQL's unsigned BIGINT becomes UINT_64;
  - `numeric(p,s)` becomes DECIMAL(p,s): INT32, INT64 or a fixed-length array by precision,
    up to 76 digits;
  - dates become DATE;
  - PostgreSQL `time` becomes TIME(µs);
  - timestamps become TIMESTAMP(µs), UTC-adjusted for `timestamptz`, whose text carries an
    offset;
  - UUIDs become UUID, JSON becomes JSON, and binary a plain byte array.

  Everything else stays text as the server wrote it, so no digit is lost: unbounded `numeric`,
  money, intervals, arrays, `timetz` and MySQL's TIME (a duration of up to ±838 hours). A value
  the column type cannot hold fails the export, naming the column and the row. Examples are
  PostgreSQL's `infinity` date or a decimal with too many digits.

- **Streaming.**
  - Export: result pages collect into a row group. A group closes at 100,000 rows or about
    8 MiB of values, whichever comes first. It is then encoded and written through the sink
    before more rows are fetched. hyparquet-writer's output buffer hands its bytes to the sink
    after each group, and the footer follows at the end.
  - Import: row groups are read one at a time, in slices of 16,384 rows. The group's column
    chunks are cached while its slices are decoded. A file with a nested column is read a whole
    group at a time, since nested pages cannot be skipped.
  - Sources without positioned reads (stdin, a gzip-wrapped file) are spooled to disk first,
    as xlsx is.
- **Codecs.**
  - Export writes Snappy (the default), ZSTD, GZIP or uncompressed pages.
  - Import reads those plus Brotli, LZ4_RAW and the deprecated Hadoop-framed LZ4.
  - GZIP, Brotli and ZSTD come from node:zlib, with each page's output bounded by its header;
    LZ4 is a 40-line block decoder here.
  - LZO and encrypted files (`PARE`) are refused with a clear message.
- **Types for new tables.** The preview types columns from the schema, not by guessing from
  sample text. This added `time` and `binary` to the inferred types, which become `time(n)` and
  `bytea`/`longblob` in a created table. The preview also reports the row count, row groups,
  codecs and the writer.

In the product:

- The export wizard, the CLI (`--format parquet`, `--codec`) and scheduled exports write
  Parquet.
- The import wizard and `joinery import` read it, and detect it by extension (`.parquet`,
  `.parq`, `.pq`) or by its `PAR1` magic.
- One table goes in each file: several tables export one file per table, or a ZIP.
- Output is never gzip-wrapped, since Parquet compresses its own pages. The CLI refuses
  `--gzip` with Parquet, and the wizard leaves gzip out of its choices.

## Consequences

- This is the first third-party dependency in `@joinery/transfer`, a deliberate exception to
  ADR 0012's stance. The format is too large to own, and both libraries are small, MIT-licensed
  and free of other dependencies. They are bundled into the job runner and the CLI like
  everything else, and the licence report lists them. hyparquet-writer pins an exact hyparquet
  version, so ours pins the same one to keep a single copy; upgrades move both together.
- Interoperability is tested. Fixtures written by pyarrow 25 (every column type, nested
  columns, six codecs, INT96) read value for value. Our files were checked with pyarrow and
  DuckDB, types included. A PostgreSQL table exported to Parquet and imported into a table
  created from the file exports to the same CSV byte for byte.
- Two hyparquet-writer limits are worked around:
  - It encodes the INTEGER logical type's bit width as the wrong Thrift type, which Arrow
    rejects. Unsigned 64-bit columns therefore carry only the legacy UINT_64 annotation, which
    every reader maps to the same type.
  - Its JSON converted type re-serialises values, which would change the server's JSON text.
    JSON columns are written with the logical type, and the converted type (which DuckDB goes
    by) is added to their schema elements just before the footer is written.
    Tests pin both, so an upgrade that changes either shows.
- Memory is one row group. 200,000 rows of an 8-column table export with about 120 MB of RSS
  growth (hyparquet-writer takes several times the values' size while encoding a group) and
  import with about 20 MB. Files from other writers with very large row groups (Spark's 128 MB)
  cost their compressed column chunks in memory while that group is read.
- Nested columns import as JSON rather than as child tables; that would be a later mapping
  option. Parquet export writes flat columns only; array columns are text.
