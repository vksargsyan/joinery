import type { SqlDialect } from '@querybara/core';

/**
 * Built-in functions offered by completion and signature help: the everyday string, numeric,
 * date/time, JSON, aggregate, window and system functions of each dialect, not the full manual.
 * Signatures are written `name(param, [optional], ...repeated) → result`; overloads are separate
 * entries with the same name.
 */

export type FunctionCategory =
  | 'aggregate'
  | 'window'
  | 'string'
  | 'numeric'
  | 'datetime'
  | 'json'
  | 'array'
  | 'conditional'
  | 'conversion'
  | 'system'
  | 'sequence'
  | 'routine';

export interface SignatureParameter {
  /** The parameter as displayed, e.g. `[count integer]`. */
  readonly label: string;
  /** Offsets of `label` within the signature's label (Monaco's [start, end] form). */
  readonly start: number;
  readonly end: number;
}

export interface FunctionSignature {
  /** `lpad(string text, length integer, [fill text]) → text`. */
  readonly label: string;
  readonly parameters: readonly SignatureParameter[];
  readonly returns?: string;
  /** Minimum argument count; optional and repeated parameters are not required. */
  readonly minArgs: number;
  /** Maximum argument count, not counting repeats of a variadic last parameter. */
  readonly maxArgs: number;
  /** The last parameter repeats (`...values`). */
  readonly variadic: boolean;
  readonly documentation?: string;
}

export interface FunctionInfo {
  /** Lower-case name. */
  readonly name: string;
  readonly category: FunctionCategory;
  readonly description: string;
  readonly signatures: readonly FunctionSignature[];
}

type Scope = 'all' | 'pg' | 'my' | 'mysql' | 'mariadb';
type Entry = readonly [Scope, FunctionCategory, string, string];

// prettier-ignore
const ENTRIES: readonly Entry[] = [
  // Aggregates.
  ['all', 'aggregate', 'count(expression) → bigint', 'Number of rows (count(*)) or of non-null values.'],
  ['all', 'aggregate', 'sum(expression)', 'Sum of the non-null values.'],
  ['all', 'aggregate', 'avg(expression)', 'Average of the non-null values.'],
  ['all', 'aggregate', 'min(expression)', 'Smallest non-null value.'],
  ['all', 'aggregate', 'max(expression)', 'Largest non-null value.'],
  ['pg', 'aggregate', 'string_agg(value text, delimiter text) → text', 'Concatenates values with a delimiter.'],
  ['pg', 'aggregate', 'array_agg(expression) → anyarray', 'Collects the values into an array.'],
  ['pg', 'aggregate', 'json_agg(expression) → json', 'Collects the values into a JSON array.'],
  ['pg', 'aggregate', 'jsonb_agg(expression) → jsonb', 'Collects the values into a JSONB array.'],
  ['pg', 'aggregate', 'json_object_agg(key, value) → json', 'Collects key/value pairs into a JSON object.'],
  ['pg', 'aggregate', 'jsonb_object_agg(key, value) → jsonb', 'Collects key/value pairs into a JSONB object.'],
  ['pg', 'aggregate', 'bool_and(expression boolean) → boolean', 'True when every value is true.'],
  ['pg', 'aggregate', 'bool_or(expression boolean) → boolean', 'True when any value is true.'],
  ['pg', 'aggregate', 'every(expression boolean) → boolean', 'SQL-standard bool_and.'],
  ['pg', 'aggregate', 'percentile_cont(fraction double precision) → double precision', 'Continuous percentile; use WITHIN GROUP (ORDER BY ...).'],
  ['pg', 'aggregate', 'percentile_disc(fraction double precision)', 'Discrete percentile; use WITHIN GROUP (ORDER BY ...).'],
  ['pg', 'aggregate', 'mode()', 'Most frequent value; use WITHIN GROUP (ORDER BY ...).'],
  ['all', 'aggregate', 'stddev(expression)', 'Sample standard deviation.'],
  ['all', 'aggregate', 'stddev_pop(expression)', 'Population standard deviation.'],
  ['all', 'aggregate', 'stddev_samp(expression)', 'Sample standard deviation.'],
  ['all', 'aggregate', 'variance(expression)', 'Sample variance.'],
  ['all', 'aggregate', 'var_pop(expression)', 'Population variance.'],
  ['all', 'aggregate', 'var_samp(expression)', 'Sample variance.'],
  ['all', 'aggregate', 'bit_and(expression)', 'Bitwise AND of the non-null values.'],
  ['all', 'aggregate', 'bit_or(expression)', 'Bitwise OR of the non-null values.'],
  ['my', 'aggregate', 'group_concat(expression) → text', 'Concatenates values: GROUP_CONCAT([DISTINCT] expr [ORDER BY ...] [SEPARATOR str]).'],
  ['my', 'aggregate', 'json_arrayagg(expression) → json', 'Collects the values into a JSON array.'],
  ['my', 'aggregate', 'json_objectagg(key, value) → json', 'Collects key/value pairs into a JSON object.'],
  ['my', 'aggregate', 'bit_xor(expression)', 'Bitwise XOR of the non-null values.'],
  ['my', 'aggregate', 'std(expression)', 'Population standard deviation.'],
  ['mysql', 'aggregate', 'any_value(expression)', 'Any value of the group; silences ONLY_FULL_GROUP_BY.'],

  // Window functions.
  ['all', 'window', 'row_number() → bigint', 'Number of the current row within its partition, from 1.'],
  ['all', 'window', 'rank() → bigint', 'Rank with gaps.'],
  ['all', 'window', 'dense_rank() → bigint', 'Rank without gaps.'],
  ['all', 'window', 'percent_rank() → double precision', 'Relative rank, (rank - 1) / (rows - 1).'],
  ['all', 'window', 'cume_dist() → double precision', 'Cumulative distribution.'],
  ['all', 'window', 'ntile(buckets integer) → integer', 'Bucket number from 1 to buckets.'],
  ['all', 'window', 'lag(value, [offset integer], [default])', 'Value from the row offset rows before.'],
  ['all', 'window', 'lead(value, [offset integer], [default])', 'Value from the row offset rows after.'],
  ['all', 'window', 'first_value(value)', 'Value at the first row of the window frame.'],
  ['all', 'window', 'last_value(value)', 'Value at the last row of the window frame.'],
  ['all', 'window', 'nth_value(value, n integer)', 'Value at the n-th row of the window frame.'],

  // Conditional.
  ['all', 'conditional', 'coalesce(value, ...values)', 'First non-null argument.'],
  ['all', 'conditional', 'nullif(value1, value2)', 'NULL when the arguments are equal, else value1.'],
  ['all', 'conditional', 'greatest(value, ...values)', 'Largest argument.'],
  ['all', 'conditional', 'least(value, ...values)', 'Smallest argument.'],
  ['my', 'conditional', 'if(condition, then_value, else_value)', 'then_value when condition is true, else else_value.'],
  ['my', 'conditional', 'ifnull(expression, fallback)', 'expression, or fallback when it is NULL.'],
  ['my', 'conditional', 'isnull(expression) → int', '1 when expression is NULL, else 0.'],

  // Conversion.
  ['all', 'conversion', 'cast(expression AS type)', 'Converts a value to a type.'],
  ['my', 'conversion', 'convert(expression, type)', 'Converts a value to a type (or USING a character set).'],
  ['pg', 'conversion', 'to_char(value, format text) → text', 'Formats a number or timestamp as text.'],
  ['pg', 'conversion', 'to_number(value text, format text) → numeric', 'Parses text as a number.'],
  ['pg', 'conversion', 'to_date(value text, format text) → date', 'Parses text as a date.'],
  ['pg', 'conversion', 'to_timestamp(value text, format text) → timestamp with time zone', 'Parses text as a timestamp.'],
  ['pg', 'conversion', 'to_timestamp(epoch double precision) → timestamp with time zone', 'Converts Unix epoch seconds to a timestamp.'],

  // Strings.
  ['all', 'string', 'lower(string) → text', 'Converts to lower case.'],
  ['all', 'string', 'upper(string) → text', 'Converts to upper case.'],
  ['pg', 'string', 'length(string text) → integer', 'Number of characters.'],
  ['my', 'string', 'length(string) → int', 'Length in bytes (CHAR_LENGTH counts characters).'],
  ['all', 'string', 'char_length(string) → integer', 'Number of characters.'],
  ['all', 'string', 'octet_length(string) → integer', 'Number of bytes.'],
  ['all', 'string', 'concat(value, ...values) → text', 'Concatenates the arguments.'],
  ['all', 'string', 'concat_ws(separator, value, ...values) → text', 'Concatenates the arguments with a separator.'],
  ['all', 'string', 'substring(string, start, [count]) → text', 'Part of a string (also SUBSTRING(string FROM start FOR count)).'],
  ['all', 'string', 'position(substring IN string) → integer', 'Position of substring in string, from 1; 0 if absent.'],
  ['all', 'string', 'trim(string) → text', 'Removes spaces: TRIM([BOTH | LEADING | TRAILING] [characters FROM] string).'],
  ['all', 'string', 'ltrim(string) → text', 'Removes leading spaces.'],
  ['all', 'string', 'rtrim(string) → text', 'Removes trailing spaces.'],
  ['all', 'string', 'replace(string, from, to) → text', 'Replaces every occurrence of from with to.'],
  ['all', 'string', 'left(string, n integer) → text', 'First n characters.'],
  ['all', 'string', 'right(string, n integer) → text', 'Last n characters.'],
  ['all', 'string', 'lpad(string, length integer, [fill]) → text', 'Pads on the left to length characters.'],
  ['all', 'string', 'rpad(string, length integer, [fill]) → text', 'Pads on the right to length characters.'],
  ['all', 'string', 'repeat(string, n integer) → text', 'The string repeated n times.'],
  ['all', 'string', 'reverse(string) → text', 'The characters in reverse order.'],
  ['all', 'string', 'ascii(string) → integer', 'Code of the first character.'],
  ['all', 'string', 'md5(string) → text', 'MD5 hash as 32 hex digits.'],
  ['all', 'string', 'regexp_replace(source, pattern, replacement, [flags]) → text', 'Replaces regular expression matches.'],
  ['pg', 'string', 'initcap(string text) → text', 'Upper-cases the first letter of each word.'],
  ['pg', 'string', 'split_part(string text, delimiter text, n integer) → text', 'The n-th field after splitting on delimiter.'],
  ['pg', 'string', 'strpos(string text, substring text) → integer', 'Position of substring, from 1; 0 if absent.'],
  ['pg', 'string', 'btrim(string text, [characters text]) → text', 'Removes characters from both ends.'],
  ['pg', 'string', 'translate(string text, from text, to text) → text', 'Replaces characters one for one.'],
  ['pg', 'string', 'starts_with(string text, prefix text) → boolean', 'True when string starts with prefix.'],
  ['pg', 'string', 'format(formatstr text, ...args) → text', 'printf-style formatting (%s, %I, %L).'],
  ['pg', 'string', 'regexp_match(string text, pattern text, [flags text]) → text[]', 'Captures of the first match.'],
  ['pg', 'string', 'regexp_matches(string text, pattern text, [flags text]) → setof text[]', 'Captures of every match (flag g).'],
  ['pg', 'string', 'regexp_split_to_array(string text, pattern text, [flags text]) → text[]', 'Splits on a regular expression.'],
  ['pg', 'string', 'regexp_split_to_table(string text, pattern text, [flags text]) → setof text', 'Splits on a regular expression, one row per part.'],
  ['pg', 'string', 'string_to_array(string text, delimiter text, [null_string text]) → text[]', 'Splits a string into an array.'],
  ['pg', 'string', 'chr(code integer) → text', 'Character with the given code.'],
  ['pg', 'string', 'to_hex(number bigint) → text', 'Hexadecimal representation.'],
  ['pg', 'string', 'quote_ident(string text) → text', 'Quotes a string as an identifier when needed.'],
  ['pg', 'string', 'quote_literal(string text) → text', 'Quotes a string as a literal.'],
  ['pg', 'string', 'encode(bytes bytea, format text) → text', 'Encodes binary data as base64, escape or hex.'],
  ['pg', 'string', 'decode(string text, format text) → bytea', 'Decodes base64, escape or hex text.'],
  ['pg', 'string', 'sha256(bytes bytea) → bytea', 'SHA-256 hash.'],
  ['my', 'string', 'instr(string, substring) → int', 'Position of substring, from 1; 0 if absent.'],
  ['my', 'string', 'locate(substring, string, [start]) → int', 'Position of substring from start, from 1; 0 if absent.'],
  ['my', 'string', 'substring_index(string, delimiter, count) → text', 'Part before (or after, count < 0) the count-th delimiter.'],
  ['my', 'string', 'mid(string, start, length) → text', 'Synonym for SUBSTRING(string, start, length).'],
  ['my', 'string', 'insert(string, position, length, newstring) → text', 'Replaces length characters at position with newstring.'],
  ['my', 'string', 'field(value, ...list) → int', 'Index of value in the list, from 1; 0 if absent.'],
  ['my', 'string', 'find_in_set(value, list) → int', 'Index of value in a comma-separated list.'],
  ['my', 'string', 'elt(n, ...strings) → text', 'The n-th string.'],
  ['my', 'string', 'format(number, decimals, [locale]) → text', 'Formats a number as #,###,###.##.'],
  ['my', 'string', 'space(n) → text', 'A string of n spaces.'],
  ['my', 'string', 'strcmp(string1, string2) → int', '-1, 0 or 1 by sort order.'],
  ['my', 'string', 'hex(value) → text', 'Hexadecimal representation.'],
  ['my', 'string', 'unhex(string) → blob', 'Bytes from hexadecimal digits.'],
  ['my', 'string', 'to_base64(string) → text', 'Base64 encoding.'],
  ['my', 'string', 'from_base64(string) → blob', 'Base64 decoding.'],
  ['my', 'string', 'sha1(string) → text', 'SHA-1 hash as 40 hex digits.'],
  ['my', 'string', 'sha2(string, hash_length) → text', 'SHA-2 hash (224, 256, 384 or 512 bits).'],
  ['my', 'string', 'regexp_instr(source, pattern, [position], [occurrence]) → int', 'Position of a regular expression match.'],
  ['my', 'string', 'regexp_substr(source, pattern, [position], [occurrence]) → text', 'Text of a regular expression match.'],
  ['mysql', 'string', 'regexp_like(source, pattern, [match_type]) → int', '1 when source matches pattern.'],
  ['mariadb', 'string', 'sformat(format, ...args) → text', 'Python-style formatting with {} placeholders.'],
  ['mariadb', 'string', 'natural_sort_key(string) → text', 'Sort key for natural ordering.'],

  // Numbers.
  ['all', 'numeric', 'abs(x) → numeric', 'Absolute value.'],
  ['all', 'numeric', 'ceil(x) → numeric', 'Smallest integer not less than x.'],
  ['all', 'numeric', 'ceiling(x) → numeric', 'Smallest integer not less than x.'],
  ['all', 'numeric', 'floor(x) → numeric', 'Largest integer not greater than x.'],
  ['all', 'numeric', 'round(x, [decimals integer]) → numeric', 'Rounds to decimals places (default 0).'],
  ['all', 'numeric', 'sign(x) → numeric', '-1, 0 or 1.'],
  ['all', 'numeric', 'sqrt(x) → double precision', 'Square root.'],
  ['all', 'numeric', 'exp(x) → double precision', 'e raised to x.'],
  ['all', 'numeric', 'ln(x) → double precision', 'Natural logarithm.'],
  ['all', 'numeric', 'log(x) → double precision', 'Logarithm (base 10 in PostgreSQL, natural in MySQL).'],
  ['all', 'numeric', 'log(base, x) → double precision', 'Logarithm of x to base.'],
  ['all', 'numeric', 'log10(x) → double precision', 'Base-10 logarithm.'],
  ['all', 'numeric', 'power(x, y) → double precision', 'x raised to y.'],
  ['all', 'numeric', 'mod(y, x) → numeric', 'Remainder of y / x.'],
  ['all', 'numeric', 'pi() → double precision', 'π.'],
  ['all', 'numeric', 'degrees(radians) → double precision', 'Radians to degrees.'],
  ['all', 'numeric', 'radians(degrees) → double precision', 'Degrees to radians.'],
  ['pg', 'numeric', 'trunc(x, [decimals integer]) → numeric', 'Truncates toward zero.'],
  ['pg', 'numeric', 'div(y numeric, x numeric) → numeric', 'Integer quotient of y / x.'],
  ['pg', 'numeric', 'cbrt(x double precision) → double precision', 'Cube root.'],
  ['pg', 'numeric', 'random() → double precision', 'Random value in [0, 1).'],
  ['pg', 'numeric', 'width_bucket(operand, low, high, count integer) → integer', 'Bucket number of operand in an equi-width histogram.'],
  ['pg', 'numeric', 'gcd(a, b)', 'Greatest common divisor.'],
  ['my', 'numeric', 'truncate(x, decimals) → numeric', 'Truncates to decimals places.'],
  ['my', 'numeric', 'rand([seed]) → double', 'Random value in [0, 1).'],
  ['my', 'numeric', 'log2(x) → double', 'Base-2 logarithm.'],
  ['my', 'numeric', 'conv(n, from_base, to_base) → text', 'Converts between number bases.'],
  ['my', 'numeric', 'crc32(expression) → int unsigned', 'CRC-32 checksum.'],

  // Dates and times.
  ['all', 'datetime', 'now() → timestamp', 'Start of the current transaction (PostgreSQL) or statement (MySQL).'],
  ['all', 'datetime', 'extract(field FROM source)', 'A date/time field: YEAR, MONTH, DAY, HOUR, EPOCH...'],
  ['pg', 'datetime', 'date_trunc(field text, source, [time_zone text])', 'Truncates to the given precision: year, month, day, hour...'],
  ['pg', 'datetime', 'date_part(field text, source) → double precision', 'A date/time field, like EXTRACT.'],
  ['pg', 'datetime', 'date_bin(stride interval, source timestamp, origin timestamp) → timestamp', 'Bins source into stride-long buckets.'],
  ['pg', 'datetime', 'age(timestamp, [timestamp]) → interval', 'Interval between timestamps (or since midnight today).'],
  ['pg', 'datetime', 'make_date(year integer, month integer, day integer) → date', 'Date from fields.'],
  ['pg', 'datetime', 'make_time(hour integer, min integer, sec double precision) → time', 'Time from fields.'],
  ['pg', 'datetime', 'make_timestamp(year integer, month integer, day integer, hour integer, min integer, sec double precision) → timestamp', 'Timestamp from fields.'],
  ['pg', 'datetime', 'make_interval([years integer], [months integer], [weeks integer], [days integer], [hours integer], [mins integer], [secs double precision]) → interval', 'Interval from fields.'],
  ['pg', 'datetime', 'clock_timestamp() → timestamp with time zone', 'Current time, changing during the statement.'],
  ['pg', 'datetime', 'statement_timestamp() → timestamp with time zone', 'Start of the current statement.'],
  ['pg', 'datetime', 'transaction_timestamp() → timestamp with time zone', 'Start of the current transaction.'],
  ['pg', 'datetime', 'justify_interval(interval) → interval', 'Normalises days and months in an interval.'],
  ['pg', 'datetime', 'isfinite(value) → boolean', 'False for infinity dates and timestamps.'],
  ['my', 'datetime', 'curdate() → date', 'Current date.'],
  ['my', 'datetime', 'curtime() → time', 'Current time.'],
  ['my', 'datetime', 'sysdate() → datetime', 'Time the function executes.'],
  ['my', 'datetime', 'utc_timestamp() → datetime', 'Current UTC date and time.'],
  ['my', 'datetime', 'unix_timestamp([date]) → bigint', 'Seconds since the Unix epoch.'],
  ['my', 'datetime', 'from_unixtime(seconds, [format]) → datetime', 'Datetime from Unix epoch seconds.'],
  ['my', 'datetime', 'date_format(date, format) → text', "Formats a date: '%Y-%m-%d %H:%i:%s'."],
  ['my', 'datetime', 'time_format(time, format) → text', 'Formats a time.'],
  ['my', 'datetime', 'str_to_date(string, format) → datetime', 'Parses a string with a DATE_FORMAT format.'],
  ['my', 'datetime', 'date_add(date, INTERVAL expr unit) → datetime', 'Adds an interval.'],
  ['my', 'datetime', 'date_sub(date, INTERVAL expr unit) → datetime', 'Subtracts an interval.'],
  ['my', 'datetime', 'adddate(date, days) → date', 'Adds days (or an INTERVAL).'],
  ['my', 'datetime', 'subdate(date, days) → date', 'Subtracts days (or an INTERVAL).'],
  ['my', 'datetime', 'addtime(datetime, time) → datetime', 'Adds a time.'],
  ['my', 'datetime', 'datediff(date1, date2) → int', 'Days from date2 to date1.'],
  ['my', 'datetime', 'timediff(time1, time2) → time', 'time1 - time2.'],
  ['my', 'datetime', 'timestampdiff(unit, datetime1, datetime2) → bigint', 'datetime2 - datetime1 in unit.'],
  ['my', 'datetime', 'timestampadd(unit, interval, datetime) → datetime', 'Adds interval units.'],
  ['my', 'datetime', 'date(expression) → date', 'Date part of a datetime.'],
  ['my', 'datetime', 'time(expression) → time', 'Time part of a datetime.'],
  ['my', 'datetime', 'timestamp(expression, [time]) → datetime', 'Datetime from a date (plus a time).'],
  ['my', 'datetime', 'year(date) → int', 'Year.'],
  ['my', 'datetime', 'month(date) → int', 'Month, 1 to 12.'],
  ['my', 'datetime', 'day(date) → int', 'Day of the month.'],
  ['my', 'datetime', 'dayofweek(date) → int', 'Weekday, 1 = Sunday.'],
  ['my', 'datetime', 'dayofyear(date) → int', 'Day of the year, 1 to 366.'],
  ['my', 'datetime', 'weekday(date) → int', 'Weekday, 0 = Monday.'],
  ['my', 'datetime', 'week(date, [mode]) → int', 'Week number.'],
  ['my', 'datetime', 'quarter(date) → int', 'Quarter, 1 to 4.'],
  ['my', 'datetime', 'hour(time) → int', 'Hour.'],
  ['my', 'datetime', 'minute(time) → int', 'Minute.'],
  ['my', 'datetime', 'second(time) → int', 'Second.'],
  ['my', 'datetime', 'last_day(date) → date', 'Last day of the month.'],
  ['my', 'datetime', 'makedate(year, dayofyear) → date', 'Date from a year and day of the year.'],
  ['my', 'datetime', 'maketime(hour, minute, second) → time', 'Time from fields.'],
  ['my', 'datetime', 'dayname(date) → text', 'Name of the weekday.'],
  ['my', 'datetime', 'monthname(date) → text', 'Name of the month.'],
  ['my', 'datetime', 'convert_tz(datetime, from_tz, to_tz) → datetime', 'Converts between time zones.'],
  ['my', 'datetime', 'to_days(date) → bigint', 'Days since year 0.'],
  ['my', 'datetime', 'sec_to_time(seconds) → time', 'Time from seconds.'],
  ['my', 'datetime', 'time_to_sec(time) → int', 'Seconds in a time.'],

  // JSON.
  ['pg', 'json', 'to_json(value) → json', 'Converts a value to JSON.'],
  ['pg', 'json', 'to_jsonb(value) → jsonb', 'Converts a value to JSONB.'],
  ['pg', 'json', 'json_build_object(...key_value) → json', 'Object from alternating keys and values.'],
  ['pg', 'json', 'jsonb_build_object(...key_value) → jsonb', 'Object from alternating keys and values.'],
  ['pg', 'json', 'json_build_array(...values) → json', 'Array from the arguments.'],
  ['pg', 'json', 'jsonb_build_array(...values) → jsonb', 'Array from the arguments.'],
  ['pg', 'json', 'jsonb_set(target jsonb, path text[], new_value jsonb, [create_if_missing boolean]) → jsonb', 'Replaces (or adds) the item at path.'],
  ['pg', 'json', 'jsonb_insert(target jsonb, path text[], new_value jsonb, [insert_after boolean]) → jsonb', 'Inserts new_value at path.'],
  ['pg', 'json', 'jsonb_extract_path(from_json jsonb, ...path text) → jsonb', 'Item at path, like #>.'],
  ['pg', 'json', 'jsonb_extract_path_text(from_json jsonb, ...path text) → text', 'Item at path as text, like #>>.'],
  ['pg', 'json', 'json_extract_path(from_json json, ...path text) → json', 'Item at path, like #>.'],
  ['pg', 'json', 'json_extract_path_text(from_json json, ...path text) → text', 'Item at path as text, like #>>.'],
  ['pg', 'json', 'jsonb_array_elements(from_json jsonb) → setof jsonb', 'One row per array element.'],
  ['pg', 'json', 'jsonb_array_elements_text(from_json jsonb) → setof text', 'One row per array element, as text.'],
  ['pg', 'json', 'json_array_elements(from_json json) → setof json', 'One row per array element.'],
  ['pg', 'json', 'jsonb_each(from_json jsonb) → setof record', 'One (key, value) row per object member.'],
  ['pg', 'json', 'jsonb_each_text(from_json jsonb) → setof record', 'One (key, value) row per member, values as text.'],
  ['pg', 'json', 'jsonb_object_keys(from_json jsonb) → setof text', 'The object keys.'],
  ['pg', 'json', 'jsonb_array_length(from_json jsonb) → integer', 'Number of array elements.'],
  ['pg', 'json', 'json_array_length(from_json json) → integer', 'Number of array elements.'],
  ['pg', 'json', 'jsonb_typeof(from_json jsonb) → text', 'object, array, string, number, boolean or null.'],
  ['pg', 'json', 'jsonb_strip_nulls(from_json jsonb) → jsonb', 'Removes object members with null values.'],
  ['pg', 'json', 'jsonb_pretty(from_json jsonb) → text', 'Indented JSON text.'],
  ['pg', 'json', 'jsonb_path_query(target jsonb, path jsonpath, [vars jsonb], [silent boolean]) → setof jsonb', 'Items a JSON path returns.'],
  ['pg', 'json', 'jsonb_path_query_first(target jsonb, path jsonpath, [vars jsonb], [silent boolean]) → jsonb', 'First item a JSON path returns.'],
  ['pg', 'json', 'jsonb_path_exists(target jsonb, path jsonpath, [vars jsonb], [silent boolean]) → boolean', 'True when a JSON path returns any item.'],
  ['pg', 'json', 'row_to_json(record, [pretty boolean]) → json', 'A row as a JSON object.'],
  ['pg', 'json', 'jsonb_to_record(from_json jsonb) → record', 'Expands an object into a row; needs AS x(col type, ...).'],
  ['pg', 'json', 'jsonb_populate_record(base anyelement, from_json jsonb) → anyelement', 'Fills a row type from an object.'],
  ['my', 'json', 'json_extract(json_doc, path, ...paths) → json', "Data at path, like ->: '$.key'."],
  ['my', 'json', 'json_unquote(json_val) → text', 'Unquotes a JSON string, like ->>.'],
  ['my', 'json', 'json_object(...key_value) → json', 'Object from alternating keys and values.'],
  ['my', 'json', 'json_array(...values) → json', 'Array from the arguments.'],
  ['my', 'json', 'json_set(json_doc, path, value, ...path_value) → json', 'Replaces or adds values.'],
  ['my', 'json', 'json_insert(json_doc, path, value, ...path_value) → json', 'Adds values without replacing.'],
  ['my', 'json', 'json_replace(json_doc, path, value, ...path_value) → json', 'Replaces existing values.'],
  ['my', 'json', 'json_remove(json_doc, path, ...paths) → json', 'Removes data at paths.'],
  ['my', 'json', 'json_contains(target, candidate, [path]) → int', '1 when candidate is contained in target.'],
  ['my', 'json', 'json_contains_path(json_doc, one_or_all, path, ...paths) → int', "1 when the paths exist ('one' or 'all')."],
  ['my', 'json', 'json_keys(json_doc, [path]) → json', 'Keys of the top-level object as an array.'],
  ['my', 'json', 'json_length(json_doc, [path]) → int', 'Number of elements or members.'],
  ['my', 'json', 'json_type(json_val) → text', 'OBJECT, ARRAY, STRING, INTEGER...'],
  ['my', 'json', 'json_valid(value) → int', '1 when the value is valid JSON.'],
  ['my', 'json', 'json_search(json_doc, one_or_all, search_str, ...args) → json', 'Paths of a string in a document.'],
  ['my', 'json', 'json_merge_patch(json_doc, ...json_docs) → json', 'RFC 7396 merge.'],
  ['my', 'json', 'json_merge_preserve(json_doc, ...json_docs) → json', 'Merges, keeping duplicate keys as arrays.'],
  ['my', 'json', 'json_array_append(json_doc, path, value, ...path_value) → json', 'Appends values to arrays.'],
  ['my', 'json', 'json_quote(string) → json', 'Quotes a string as a JSON string.'],
  ['my', 'json', 'json_value(json_doc, path)', 'Scalar at path.'],
  ['my', 'json', 'json_depth(json_doc) → int', 'Maximum depth.'],
  ['mysql', 'json', 'json_pretty(json_val) → text', 'Indented JSON text.'],
  ['mysql', 'json', 'json_overlaps(json_doc1, json_doc2) → int', '1 when the documents share a key/value or element.'],
  ['mariadb', 'json', 'json_query(json_doc, path) → json', 'Object or array at path.'],
  ['mariadb', 'json', 'json_exists(json_doc, path) → int', '1 when the path exists.'],
  ['mariadb', 'json', 'json_detailed(json_doc) → text', 'Indented JSON text.'],
  ['mariadb', 'json', 'json_compact(json_doc) → text', 'JSON text without spaces.'],

  // Arrays and set-returning functions.
  ['pg', 'array', 'array_length(array anyarray, dimension integer) → integer', 'Length of the given dimension.'],
  ['pg', 'array', 'cardinality(array anyarray) → integer', 'Total number of elements.'],
  ['pg', 'array', 'array_append(array anyarray, element anyelement) → anyarray', 'Appends an element.'],
  ['pg', 'array', 'array_prepend(element anyelement, array anyarray) → anyarray', 'Prepends an element.'],
  ['pg', 'array', 'array_cat(array1 anyarray, array2 anyarray) → anyarray', 'Concatenates arrays.'],
  ['pg', 'array', 'array_position(array anyarray, element anyelement) → integer', 'Index of the first occurrence.'],
  ['pg', 'array', 'array_remove(array anyarray, element anyelement) → anyarray', 'Removes every occurrence.'],
  ['pg', 'array', 'array_to_string(array anyarray, delimiter text, [null_string text]) → text', 'Joins the elements.'],
  ['pg', 'array', 'unnest(array anyarray) → setof anyelement', 'One row per element.'],
  ['pg', 'array', 'generate_series(start, stop, [step]) → setof', 'Rows from start to stop.'],

  // Sequences.
  ['pg', 'sequence', 'nextval(sequence regclass) → bigint', 'Advances the sequence and returns the new value.'],
  ['pg', 'sequence', 'currval(sequence regclass) → bigint', 'Value nextval last returned in this session.'],
  ['pg', 'sequence', 'setval(sequence regclass, value bigint, [is_called boolean]) → bigint', 'Sets the current value.'],
  ['pg', 'sequence', 'lastval() → bigint', 'Value nextval last returned for any sequence.'],
  ['mariadb', 'sequence', 'nextval(sequence) → bigint', 'Advances the sequence and returns the new value.'],
  ['mariadb', 'sequence', 'lastval(sequence) → bigint', 'Value last generated in this session.'],
  ['mariadb', 'sequence', 'setval(sequence, value, [is_used], [round]) → bigint', 'Sets the next value.'],

  // System and session.
  ['pg', 'system', 'current_database() → name', 'Name of the current database.'],
  ['pg', 'system', 'current_schema() → name', 'First schema in the search path.'],
  ['pg', 'system', 'current_schemas(include_implicit boolean) → name[]', 'Schemas in the search path.'],
  ['pg', 'system', 'current_setting(setting_name text, [missing_ok boolean]) → text', 'Current value of a setting.'],
  ['pg', 'system', 'set_config(setting_name text, new_value text, is_local boolean) → text', 'Sets a setting.'],
  ['pg', 'system', 'version() → text', 'Server version string.'],
  ['pg', 'system', 'pg_typeof(value) → regtype', 'Type of the value.'],
  ['pg', 'system', 'pg_sleep(seconds double precision) → void', 'Sleeps.'],
  ['pg', 'system', 'pg_size_pretty(size bigint) → text', 'Human-readable size.'],
  ['pg', 'system', 'pg_total_relation_size(relation regclass) → bigint', 'Disk space of a table with indexes and TOAST.'],
  ['pg', 'system', 'pg_relation_size(relation regclass) → bigint', 'Disk space of the main fork.'],
  ['pg', 'system', 'pg_database_size(name) → bigint', 'Disk space of a database.'],
  ['pg', 'system', 'pg_backend_pid() → integer', 'Process ID of this session.'],
  ['pg', 'system', 'pg_cancel_backend(pid integer) → boolean', "Cancels a session's query."],
  ['pg', 'system', 'pg_terminate_backend(pid integer) → boolean', 'Terminates a session.'],
  ['pg', 'system', 'gen_random_uuid() → uuid', 'Random version 4 UUID.'],
  ['my', 'system', 'database() → text', 'Current database.'],
  ['my', 'system', 'user() → text', 'User and host of the connection.'],
  ['my', 'system', 'current_user() → text', 'Authenticated user.'],
  ['my', 'system', 'version() → text', 'Server version string.'],
  ['my', 'system', 'connection_id() → bigint', 'Connection (thread) ID.'],
  ['my', 'system', 'last_insert_id([expression]) → bigint', 'Last AUTO_INCREMENT value generated by this session.'],
  ['my', 'system', 'row_count() → bigint', 'Rows the previous statement changed.'],
  ['my', 'system', 'found_rows() → bigint', 'Rows the previous SELECT would have returned without LIMIT.'],
  ['my', 'system', 'sleep(seconds) → int', 'Sleeps.'],
  ['my', 'system', 'uuid() → text', 'Version 1 UUID.'],
  ['my', 'system', 'uuid_short() → bigint', 'Short unique integer.'],
  ['my', 'system', 'inet_aton(address) → int unsigned', 'IPv4 address to a number.'],
  ['my', 'system', 'inet_ntoa(number) → text', 'Number to an IPv4 address.'],
  ['my', 'system', 'get_lock(name, timeout) → int', 'Takes a named lock.'],
  ['my', 'system', 'release_lock(name) → int', 'Releases a named lock.'],
  ['mysql', 'system', 'uuid_to_bin(uuid, [swap_flag]) → binary(16)', 'UUID text to 16 bytes.'],
  ['mysql', 'system', 'bin_to_uuid(bytes, [swap_flag]) → text', '16 bytes to UUID text.'],
  ['mariadb', 'system', 'sys_guid() → text', 'Globally unique identifier.'],
];

const SCOPES: Readonly<Record<SqlDialect, ReadonlySet<Scope>>> = {
  postgres: new Set<Scope>(['all', 'pg']),
  mysql: new Set<Scope>(['all', 'my', 'mysql']),
  mariadb: new Set<Scope>(['all', 'my', 'mariadb']),
};

/** Parses `name(a, [b], ...c) → result` into a signature. */
function parseSignature(
  text: string,
  documentation?: string,
): { name: string; signature: FunctionSignature } {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const name = text.slice(0, open).trim();
  const inner = text.slice(open + 1, close).trim();
  const arrow = text.indexOf('→', close);
  const returns = arrow >= 0 ? text.slice(arrow + 1).trim() : undefined;
  return {
    name,
    signature: makeSignature(name, inner ? inner.split(/,\s*/) : [], returns, documentation),
  };
}

/** A signature from parameter labels; `[x]` is optional and `...x` repeats. */
export function makeSignature(
  name: string,
  params: readonly string[],
  returns: string | undefined,
  documentation?: string,
): FunctionSignature {
  let label = `${name}(`;
  const parameters: SignatureParameter[] = [];
  let minArgs = 0;
  let variadic = false;
  params.forEach((param, index) => {
    if (index > 0) label += ', ';
    parameters.push({ label: param, start: label.length, end: label.length + param.length });
    label += param;
    if (param.startsWith('...')) variadic = true;
    else if (!param.startsWith('[')) minArgs = index + 1;
  });
  const maxArgs = params.length;
  label += ')';
  if (returns) label += ` → ${returns}`;
  const signature: {
    label: string;
    parameters: SignatureParameter[];
    minArgs: number;
    maxArgs: number;
    variadic: boolean;
    returns?: string;
    documentation?: string;
  } = { label, parameters, minArgs, maxArgs, variadic };
  if (returns) signature.returns = returns;
  if (documentation) signature.documentation = documentation;
  return signature;
}

const cache = new Map<SqlDialect, ReadonlyMap<string, FunctionInfo>>();

/** Built-in functions of `dialect`, by lower-case name. */
export function builtinFunctions(dialect: SqlDialect): ReadonlyMap<string, FunctionInfo> {
  const cached = cache.get(dialect);
  if (cached) return cached;
  const scopes = SCOPES[dialect];
  const byName = new Map<string, { info: FunctionInfo; signatures: FunctionSignature[] }>();
  for (const [scope, category, text, description] of ENTRIES) {
    if (!scopes.has(scope)) continue;
    const { name, signature } = parseSignature(text, description);
    const existing = byName.get(name);
    if (existing) {
      existing.signatures.push(signature);
      continue;
    }
    const signatures = [signature];
    byName.set(name, { info: { name, category, description, signatures }, signatures });
  }
  const map = new Map<string, FunctionInfo>();
  for (const [name, { info }] of byName) map.set(name, info);
  cache.set(dialect, map);
  return map;
}
