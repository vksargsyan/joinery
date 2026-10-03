# 0022. Redis dump analysis: our own streaming RDB reader, run by the job runner

- Status: Accepted
- Date: 2026-09-30

## Context

The Big keys tool (ADR 0007) samples a live server with SCAN and MEMORY USAGE. It is quick, but
it only estimates: it sees a sample, it adds load to production, and it needs a connection.
An RDB snapshot (dump.rdb) holds every key, can be copied from any server or taken from a
managed service's backups, and can be read without touching the server. Tools like
redis-rdb-tools and rdb-cli read such files, but they are Python or Go programs to install
separately, and several stopped at older formats.

The RDB format is versioned (1 to 13 in Redis up to 8.6). Valkey 9 writes its own versions (80
and up, with a `VALKEY` header) and gives type numbers 22 and 23 other meanings. Values are
length-prefixed strings, compact encodings (listpack, ziplist, intset, zipmap) held as strings,
LZF-compressed strings, module values described by opcodes, streams with consumer groups, and
hashes with per-field expiry. A dump can be many gigabytes.

## Decision

**A streaming RDB reader in `@querybara/redis-tools` (`rdb.ts`, `rdb-analysis.ts`), run by the
job runner, shown in a Dump analysis panel.**

- **The reader** is pure TypeScript and browser-safe, like the rest of redis-tools:
  - It takes the file as a stream of chunks and reports each key: database, name (up to 4 KiB),
    type, encoding, bytes in the file (its expiry and metadata included), element count and
    expiry. Its value is never kept.
  - Large values are skipped as they stream past. Only compact blobs are read, for their element
    counts: from the header, or by walking entries when the 16-bit count overflowed.
  - LZF decompression is in the reader.
  - Module values are skipped through their opcodes, and their type is named from the module id
    (`ReJSON-RL`, `TSDB-TYPE`, `MBbloom--`).
  - Key metadata (Redis 8.6), module AUX data and functions are skipped and counted.
  - Hash field TTLs are counted, both in hash tables and in Redis 7.4's listpack triplets.
  - A damaged or unknown part throws `RdbError` with its offset. The keys before it have already
    been reported.
- **The analysis** sums as the file streams, so its memory does not grow with the file:
  - keys and bytes by database, type (with encodings) and expiry bucket, measured from the dump's
    own `ctime`;
  - key patterns (`user:*:profile`), using the live Big keys aggregation, which is now a
    streaming `PatternAggregator` capped at 20,000 patterns;
  - the 100 largest keys by bytes, and by element count.

  A file that stops partway still yields the analysis of what was read, marked `stopped`.

- **Tested on real dumps.** Fixtures written by Redis 6.2, 7.0, 7.2, 7.4, 8.2 and 8.6 and Valkey
  8.1 and 9.0 each hold every type and encoding. Each is read to its last byte, at any chunk
  size, with the same result. Formats no current server writes (linked lists, text zset scores,
  zipmaps) are built by a small writer in the tests. On one million small keys the reader runs
  at about 700,000 keys a second, with flat memory.
- **Where it runs.** Reading a large file is CPU work, so it runs in the job runner (ADR 0006),
  not in main or the page. It is a runner request rather than a job, because it belongs to no
  connection:
  - The protocol gains `rdb-analyze`, `request-progress` and `cancel-request`.
  - `JobManager.request` takes a signal, a progress callback and no time limit.
  - Main's `redisDump.analyze` reads only a file this window picked with `dialogs.openFile`
    (ADR 0006's file grants), relays progress, and checks the runner's report.
  - Main's contract carries no opaque bytes, so key names cross as display text (`displayBytes`,
    lossless with `parseDisplayBytes`).
- **The panel** is connection-less, like Schedules, and opens from any Redis connection's Tools
  folder and from Big keys. You pick a file and watch its progress (rate, time left, cancel).
  The report shows:
  - the server version and save time, and totals;
  - types with a share bar and their encodings;
  - expiry buckets;
  - patterns;
  - the largest keys and the ones with the most elements;
  - databases and the AUX fields.

  You can save it as JSON.

## Consequences

- Sizes are bytes in the dump, not memory in a server. Strings are compressed and encodings are
  compact, so memory runs higher. The proportions hold, and the report labels the figures as
  such (with the server's `used-mem` at save time beside them).
- New RDB versions or types need the reader updated. An unknown type stops the reading with
  its number, and the report covers the keys before it. Redis 8.6 (RDB 13) and Valkey 9 (80, 81) are read today, except Valkey's slot import state and pre-release formats (Redis 4.0 RC
  modules, 7.0 RC functions).
- No checksum verification yet: the CRC-64 is shown, not checked.
- Nothing is uploaded or connected: a dump from a production server can be analysed on a
  laptop.
