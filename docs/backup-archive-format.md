# The Joinery backup archive (.jbak), version 1

A `.jbak` file is what Joinery's backups write by default (spec §14): the desktop app's Backup
wizard, `joinery backup` and the `@joinery/backup` package all produce it. It holds one entry
per object (DDL, rows, documents, keys) and a manifest describing them, so a restore can pick
objects without reading the rest. An archive can be encrypted with a passphrase; then every
byte after the header is authenticated and any change is detected.

The reference implementation is `packages/backup/src/archive/` (`format.ts`, `crypto.ts`,
`writer.ts`, `reader.ts`, `manifest.ts`). This page is the contract: a reader written from it
must open every archive Joinery writes.

## Layout

All integers are unsigned and big-endian.

```
header    magic | u16 version | u16 flags | u32 n | n bytes of JSON | [32-byte MAC]
entry 0   entry header | frame | frame | ... (the last frame has the LAST bit)
entry 1   ...
manifest  an entry with index 0xFFFFFFFF, holding the manifest JSON
trailer   "JBAKEND\0" | u64 manifest offset | u64 manifest length | u32 0 | u32 CRC-32
```

### Header

| Bytes | Field                                                                  |
| ----- | ---------------------------------------------------------------------- |
| 0-7   | Magic `4A 42 41 4B 0D 0A 1A 0A` ("JBAK\r\n", Ctrl-Z, "\n")             |
| 8-9   | Format version: `1`                                                    |
| 10-11 | Flags: `0x1` encrypted, `0x2` compressed; other bits are 0             |
| 12-15 | `n`, the length of the header JSON (at most 64 KiB)                    |
| 16-   | Header JSON, UTF-8                                                     |
| then  | Encrypted archives only: HMAC-SHA256 of bytes 0 to the end of the JSON |

The header JSON is `{"compression": "gzip" | "none"}`, and for an encrypted archive also
`"cipher": "aes-256-gcm"` and `"kdf": {"name": "scrypt", "log2N", "r", "p", "salt"}` (salt:
16 random bytes, base64). The flags and the JSON must agree. A reader refuses other versions
and ciphers, and scrypt costs outside `log2N` 10-20, `r` 1-32, `p` 1-16 and 1 GiB of memory, so
a crafted header cannot make it spend hours or gigabytes.

### Entries and frames

An entry is a 16-byte entry header followed by frames:

| Bytes | Field                                                                 |
| ----- | --------------------------------------------------------------------- |
| 0-3   | `4A 45 4E 54` ("JENT")                                                |
| 4-7   | The entry's index (0, 1, 2... in file order; `0xFFFFFFFF` = manifest) |
| 8-15  | Nonce prefix: 8 random bytes (encrypted), zeros (plain)               |

Each frame is a `u32` word, bit 31 set on the entry's last frame and bits 0-30 the payload
length, then:

- plain archives: the payload, then a CRC-32 of the word and the payload;
- encrypted archives: the AES-256-GCM ciphertext of the payload (same length), then its
  16-byte tag.

Writers use 64 KiB payloads; readers refuse frames over 16 MiB. Every entry has at least one
frame (an empty entry is one empty last frame).

The payloads, joined, are the entry's stored content: with the compressed flag, a gzip stream
of the content (each entry compressed on its own), otherwise the content itself.

### Encryption

The passphrase (Unicode NFC) and the header salt go through scrypt with the header's cost to 64
bytes: the first 32 are the AES-256-GCM key, the last 32 the HMAC key. The header MAC tells a
wrong passphrase apart from a damaged file before any entry is read. Joinery writes
`log2N 17, r 8, p 1`. The passphrase is not stored anywhere.

Frames follow the STREAM construction. Frame `i` (counting from 0 in each entry) is sealed
with:

- nonce: the entry's 8-byte prefix followed by `u32 i` (12 bytes);
- associated data: the 16-byte entry header, `u32 i`, and one byte, `1` on the last frame and
  `0` otherwise.

So a frame cannot be changed, reordered, moved to another entry or index, or dropped from the
end of an entry without the tag check failing. Nonce prefixes are random per entry, so nonces
never repeat under one key.

### Manifest and trailer

The last 32 bytes are the trailer. Its CRC-32 covers its first 28 bytes; the manifest offset
plus length plus 32 must equal the file size. The manifest entry at that offset is framed,
compressed and encrypted like the others, and holds UTF-8 JSON:

```json
{
  "format": "joinery-backup",
  "formatVersion": 1,
  "createdAt": "2026-09-29T12:00:00.000Z",
  "producer": "Joinery",
  "engine": "postgres",
  "serverVersion": "16.4",
  "database": "shop",
  "databaseOptions": { "encoding": "UTF8" },
  "options": { "snapshot": "repeatable-read", "compression": "gzip", "encrypted": true },
  "objects": [
    {
      "id": "table:public.orders:create",
      "kind": "table",
      "schema": "public",
      "name": "orders",
      "qualifiedName": "public.orders",
      "dependsOn": ["schema:public:create"],
      "ddl": "ddl/0003-table-public.orders.json",
      "data": { "entry": "data/0003-public.orders.sql", "count": 1200, "columns": ["id", "total"] }
    }
  ],
  "entries": [
    {
      "name": "ddl/0003-table-public.orders.json",
      "index": 4,
      "offset": 5120,
      "storedLength": 311,
      "size": 402,
      "sha256": "…64 hex digits…",
      "contentType": "application/json"
    }
  ],
  "warnings": []
}
```

- `objects` are in creation order. `kind` is one of `schema`, `extension`, `type`, `sequence`,
  `table`, `partition`, `index`, `unique`, `check`, `primary-key`, `column`, `foreign-key`,
  `trigger`, `view`, `materialized-view`, `routine`, `event`, `grants`, `collection`, `keys`.
  `dependsOn` lists the ids that must exist first; `parent` names the table an attached object
  (foreign key, trigger...) belongs to. A selective restore takes the chosen objects, what they
  depend on, and what is attached to them; a foreign key comes only with both of its tables.
- `entries` locate every entry (not the manifest): `offset` of its entry header, `storedLength`
  of header and frames, and the `size` and lower-case hex `sha256` of its uncompressed content.
  A reader checks both after reading an entry.
- `contentType` is `application/sql`, `application/json`, `application/bson` or
  `application/x-ndjson`.

## What the entries hold

**SQL engines.** `ddl/NNNN-<kind>-<name>.json` holds one object's statements,
`{"pre": [...], "data": [...], "post": [...], "grants": [...]}`: `pre` creates it, `data` runs
after the rows (sequence positions, materialized view refreshes), `post` runs after every table
is loaded (foreign keys, triggers, events), and `grants` are optional. `data/NNNN-<name>.sql`
holds a table's rows as multi-row `INSERT` statements, each ending with `;` and a newline.
Restores run all `pre`, then rows, then `data`, then `post`, then `grants`.

**MongoDB.** `meta/NNNN-<name>.json` is `{"name", "type", "options", "indexes"}` with the
`listCollections` options (validator, collation, capped, time series...) and each index
specification as canonical Extended JSON. `data/NNNN-<name>.bson` holds concatenated BSON
documents, or `.jsonl` one canonical Extended JSON document per line.

**Redis.** `keys/<database>.bson` holds concatenated BSON documents, one per key:
`{"k": binary key, "v": binary DUMP payload, "t": int64 PTTL in ms (-1 for none),
"x": int64 expiry in Unix ms or null}`. A restore uses `RESTORE` with the remaining TTL, or with
`ABSTTL` and `x` when asked to keep the original expiry.

## Compatibility

Version 1 readers must refuse archives with another version in the header and manifest. New
optional manifest fields, `detail` and `options` values and header JSON fields may be added
without a version change; readers ignore what they do not know. Anything that changes the byte
layout, the cipher construction, the list of object kinds or the meaning of an existing field
needs version 2.
