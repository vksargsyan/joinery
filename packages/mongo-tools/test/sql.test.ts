import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  SqlTranslationError,
  formatShellInline,
  parseFindText,
  parseShellPipeline,
  sqlToMql,
  toEjson,
  toFindQuery,
  type SqlTranslation,
} from '../src';

/** The one-line mongosh text of a translation. */
function mql(sql: string): string {
  return sqlToMql(sql, { multiline: false }).text;
}

function failure(sql: string): SqlTranslationError {
  try {
    sqlToMql(sql);
  } catch (error) {
    if (error instanceof SqlTranslationError) return error;
    throw error;
  }
  throw new Error(`expected "${sql}" to fail`);
}

describe('SQL to find()', () => {
  it('selects columns, paths, aliases and values', () => {
    expect(mql('SELECT name, address.city FROM customers')).toBe(
      "db.customers.find({}, { name: 1, 'address.city': 1, _id: 0 })",
    );
    expect(mql('SELECT name AS n, address.city city, 5 AS five FROM customers')).toBe(
      "db.customers.find({}, { n: '$name', city: '$address.city', five: { $literal: 5 }, _id: 0 })",
    );
    expect(mql('SELECT _id, name FROM customers')).toBe(
      'db.customers.find({}, { _id: 1, name: 1 })',
    );
    expect(mql('SELECT _id AS id FROM customers')).toBe(
      "db.customers.find({}, { id: '$_id', _id: 0 })",
    );
    expect(mql("SELECT 'x', name FROM t")).toBe(
      "db.t.find({}, { expr1: { $literal: 'x' }, name: 1, _id: 0 })",
    );
    expect(mql('SELECT * FROM customers')).toBe('db.customers.find({})');
    expect(mql('SELECT customers.* FROM customers')).toBe('db.customers.find({})');
    expect(mql('SELECT c.* FROM customers AS c')).toBe('db.customers.find({})');
  });

  it('reads quoted identifiers, qualifiers, comments and keywords in any case', () => {
    expect(mql('select `first name`, "last-name", c."order".total from "my coll" c')).toBe(
      "db.getCollection('my coll').find({}, { 'first name': 1, 'last-name': 1, 'order.total': 1, _id: 0 })",
    );
    expect(mql('SELECT "a""b", `c``d` FROM t')).toBe(
      "db.t.find({}, { 'a\"b': 1, 'c`d': 1, _id: 0 })",
    );
    expect(mql('SELECT orders.status FROM orders WHERE orders.qty > 1')).toBe(
      'db.orders.find({ qty: { $gt: 1 } }, { status: 1, _id: 0 })',
    );
    expect(mql('SELECT items.0.sku FROM fs.files -- first item\n/* block */ WHERE size > 0')).toBe(
      "db.getCollection('fs.files').find({ size: { $gt: 0 } }, { 'items.0.sku': 1, _id: 0 })",
    );
    // A dotted collection name qualifies columns as a whole.
    expect(mql('SELECT fs.files.length FROM fs.files')).toBe(
      "db.getCollection('fs.files').find({}, { length: 1, _id: 0 })",
    );
    // Names are case-sensitive; keywords are not.
    expect(mql('SeLeCt Name FrOm People WhErE Age >= 21;')).toBe(
      'db.People.find({ Age: { $gte: 21 } }, { Name: 1, _id: 0 })',
    );
  });

  it('types literals as the shell does', () => {
    expect(
      mql(
        "SELECT * FROM t WHERE a = 1 AND b = 3000000000 AND c = 1.0 AND d = 2.5e3 AND e = -7 AND f = 'it''s' AND g = TRUE AND h = FALSE",
      ),
    ).toBe(
      "db.t.find({ a: 1, b: Long('3000000000'), c: 1.0, d: 2500.0, e: -7, f: 'it\\'s', g: true, h: false })",
    );
    expect(
      mql(
        "SELECT * FROM t WHERE d = DATE '2024-02-29' AND ts = TIMESTAMP '2024-01-02 03:04:05.678' AND z = TIMESTAMP '2024-01-02T03:04:05+02:00' AND id = objectid('65a1b2c3d4e5f60718293a4b')",
      ),
    ).toBe(
      "db.t.find({ d: ISODate('2024-02-29T00:00:00.000Z'), ts: ISODate('2024-01-02T03:04:05.678Z'), z: ISODate('2024-01-02T01:04:05.000Z'), id: ObjectId('65a1b2c3d4e5f60718293a4b') })",
    );
    expect(mql('SELECT top, date, count FROM t')).toBe(
      'db.t.find({}, { top: 1, date: 1, count: 1, _id: 0 })',
    );
    expect(mql('SELECT * FROM t WHERE n = 99999999999999999999 AND m = .5')).toBe(
      'db.t.find({ n: 100000000000000000000.0, m: 0.5 })',
    );
  });

  it('translates comparisons, keeping SQL NULL semantics', () => {
    expect(mql('SELECT * FROM t WHERE a = 1 AND b <> 2 AND c != 3 AND d < 4 AND e <= 5')).toBe(
      'db.t.find({ a: 1, b: { $nin: [ 2, null ] }, c: { $nin: [ 3, null ] }, d: { $lt: 4 }, e: { $lte: 5 } })',
    );
    expect(mql('SELECT * FROM t WHERE 5 < a AND 6 >= b')).toBe(
      'db.t.find({ a: { $gt: 5 }, b: { $lte: 6 } })',
    );
    // Conditions on one field merge; clashing ones go to $and.
    expect(mql('SELECT * FROM t WHERE a > 1 AND a < 5 AND a <> 3')).toBe(
      'db.t.find({ a: { $gt: 1, $lt: 5, $nin: [ 3, null ] } })',
    );
    expect(mql('SELECT * FROM t WHERE a = 1 AND a = 2')).toBe(
      'db.t.find({ a: 1, $and: [ { a: 2 } ] })',
    );
    expect(mql('SELECT * FROM t WHERE a IS NULL AND b IS NOT NULL')).toBe(
      'db.t.find({ a: null, b: { $ne: null } })',
    );
    expect(mql('SELECT * FROM t WHERE a IS TRUE AND b IS NOT FALSE AND active')).toBe(
      'db.t.find({ a: true, b: { $ne: false }, active: true })',
    );
  });

  it('pushes NOT down instead of wrapping filters', () => {
    expect(mql('SELECT * FROM t WHERE NOT (a = 1)')).toBe(
      'db.t.find({ a: { $nin: [ 1, null ] } })',
    );
    expect(mql('SELECT * FROM t WHERE NOT (a > 5 OR b <> 3)')).toBe(
      'db.t.find({ a: { $lte: 5 }, b: 3 })',
    );
    expect(mql('SELECT * FROM t WHERE NOT (a = 1 AND b = 2)')).toBe(
      'db.t.find({ $or: [ { a: { $nin: [ 1, null ] } }, { b: { $nin: [ 2, null ] } } ] })',
    );
    expect(mql('SELECT * FROM t WHERE NOT NOT a = 1')).toBe('db.t.find({ a: 1 })');
    expect(mql('SELECT * FROM t WHERE NOT active')).toBe('db.t.find({ active: false })');
    expect(mql('SELECT * FROM t WHERE NOT a IS NULL')).toBe('db.t.find({ a: { $ne: null } })');
  });

  it('translates AND, OR and parentheses', () => {
    expect(mql("SELECT * FROM t WHERE a = 1 OR b = 2 OR (c = 3 AND (d = 4 OR e = 'x'))")).toBe(
      "db.t.find({ $or: [ { a: 1 }, { b: 2 }, { c: 3, $or: [ { d: 4 }, { e: 'x' } ] } ] })",
    );
    expect(mql('SELECT * FROM t WHERE (a = 1 OR b = 2) AND (c = 3 OR d = 4)')).toBe(
      'db.t.find({ $or: [ { a: 1 }, { b: 2 } ], $and: [ { $or: [ { c: 3 }, { d: 4 } ] } ] })',
    );
    expect(mql('SELECT * FROM t WHERE TRUE')).toBe('db.t.find({})');
    expect(mql('SELECT * FROM t WHERE FALSE OR a = 1')).toBe('db.t.find({ a: 1 })');
    expect(mql('SELECT * FROM t WHERE 1 = 1 AND a = 2')).toBe(
      'db.t.find({ $expr: { $eq: [ 1, 1 ] }, a: 2 })',
    );
  });

  it('translates IN, BETWEEN and field comparisons', () => {
    expect(mql("SELECT * FROM t WHERE a IN (1, 'x') AND b NOT IN (2, 3)")).toBe(
      "db.t.find({ a: { $in: [ 1, 'x' ] }, b: { $nin: [ 2, 3, null ] } })",
    );
    expect(mql('SELECT * FROM t WHERE a BETWEEN 1 AND 10')).toBe(
      'db.t.find({ a: { $gte: 1, $lte: 10 } })',
    );
    expect(mql('SELECT * FROM t WHERE a NOT BETWEEN 1 AND 10')).toBe(
      'db.t.find({ $or: [ { a: { $lt: 1 } }, { a: { $gt: 10 } } ] })',
    );
    expect(mql('SELECT * FROM t WHERE a < b')).toBe(
      "db.t.find({ a: { $ne: null }, b: { $ne: null }, $expr: { $lt: [ '$a', '$b' ] } })",
    );
    expect(mql('SELECT * FROM t WHERE NOT (x.y = z)')).toBe(
      "db.t.find({ 'x.y': { $ne: null }, z: { $ne: null }, $expr: { $ne: [ '$x.y', '$z' ] } })",
    );
  });

  it('translates LIKE to anchored, escaped regular expressions', () => {
    const like = (pattern: string, extra = '') =>
      mql(`SELECT * FROM t WHERE name ${extra}LIKE ${pattern}`);
    expect(like("'abc%'")).toBe('db.t.find({ name: /^abc/ })');
    expect(like("'%abc'")).toBe('db.t.find({ name: /abc$/ })');
    expect(like("'%abc%'")).toBe('db.t.find({ name: /abc/ })');
    expect(like("'abc'")).toBe('db.t.find({ name: /^abc$/ })');
    expect(like("'a_c%'")).toBe('db.t.find({ name: /^a.c/s })');
    expect(like("'a%c'")).toBe('db.t.find({ name: /^a.*c$/s })');
    expect(like("'%'")).toBe('db.t.find({ name: /^.*$/s })');
    expect(like("''")).toBe('db.t.find({ name: /^$/ })');
    expect(like("'1+1=2 (a.b) [x] {y} ^$|?*/'")).toBe(
      'db.t.find({ name: /^1\\+1=2 \\(a\\.b\\) \\[x\\] \\{y\\} \\^\\$\\|\\?\\*\\/$/ })',
    );
    expect(like("'100\\%'")).toBe('db.t.find({ name: /^100%$/ })');
    expect(like("'100!%%' ESCAPE '!'")).toBe('db.t.find({ name: /^100%/ })');
    expect(like("'a\\b' ESCAPE ''")).toBe('db.t.find({ name: /^a\\\\b$/ })');
    expect(like("'abc%'", 'NOT ')).toBe('db.t.find({ name: { $not: /^abc/, $ne: null } })');
    expect(mql("SELECT * FROM t WHERE name ILIKE 'abc%'")).toBe('db.t.find({ name: /^abc/i })');
    expect(mql("SELECT * FROM t WHERE name NOT ILIKE '%a_'")).toBe(
      'db.t.find({ name: { $not: /a.$/is, $ne: null } })',
    );
  });

  it('sorts by column, alias and position, and pages', () => {
    expect(mql('SELECT name, address.city AS city FROM c ORDER BY city DESC, 1, age ASC')).toBe(
      "db.c.find({}, { name: 1, city: '$address.city', _id: 0 }).sort({ 'address.city': -1, name: 1, age: 1 })",
    );
    expect(mql('SELECT * FROM c ORDER BY a DESC NULLS LAST, b NULLS FIRST LIMIT 10')).toBe(
      'db.c.find({}).sort({ a: -1, b: 1 }).limit(10)',
    );
    expect(mql('SELECT * FROM c LIMIT 10 OFFSET 20')).toBe('db.c.find({}).skip(20).limit(10)');
    expect(mql('SELECT * FROM c OFFSET 20 ROWS LIMIT 10')).toBe('db.c.find({}).skip(20).limit(10)');
    expect(mql('SELECT * FROM c LIMIT 20, 10')).toBe('db.c.find({}).skip(20).limit(10)');
    expect(mql('SELECT * FROM c OFFSET 5')).toBe('db.c.find({}).skip(5)');
    expect(mql('SELECT * FROM c LIMIT 5 OFFSET 0')).toBe('db.c.find({}).limit(5)');
  });

  it('returns the query as data, its columns and multi-line text', () => {
    const translation = sqlToMql(
      'SELECT name AS n, age FROM people WHERE age > 21 ORDER BY age LIMIT 5',
    );
    expect(translation.kind).toBe('find');
    if (translation.kind !== 'find') return;
    expect(translation.collection).toBe('people');
    expect(translation.columns).toEqual(['n', 'age']);
    expect(toFindQuery(translation.query)).toEqual({
      filter: '{"age":{"$gt":{"$numberInt":"21"}}}',
      projection: '{"n":"$name","age":{"$numberInt":"1"},"_id":{"$numberInt":"0"}}',
      sort: '{"age":{"$numberInt":"1"}}',
      limit: 5,
    });
    expect(translation.text).toBe(
      "db.people.find({ age: { $gt: 21 } }, { n: '$name', age: 1, _id: 0 })\n  .sort({ age: 1 })\n  .limit(5)",
    );
    const parsed = parseFindText(translation.text);
    expect(parsed.collection).toBe('people');
    expect(toFindQuery(parsed.query)).toEqual(toFindQuery(translation.query));
    expect(sqlToMql('SELECT * FROM t').columns).toBeUndefined();
  });
});

describe('SQL to aggregate()', () => {
  it('groups, with a flat projection after the $group', () => {
    expect(
      mql(
        'SELECT status, COUNT(*) AS n, SUM(qty), AVG(price) avg_price, MIN(price), MAX(at) FROM orders GROUP BY status',
      ),
    ).toBe(
      "db.orders.aggregate([ { $group: { _id: '$status', n: { $sum: 1 }, sum_qty: { $sum: '$qty' }, avg_price: { $avg: '$price' }, min_price: { $min: '$price' }, max_at: { $max: '$at' } } }, { $project: { _id: 0, status: '$_id', n: '$n', sum_qty: '$sum_qty', avg_price: '$avg_price', min_price: '$min_price', max_at: '$max_at' } } ])",
    );
  });

  it('groups by several keys, putting null and missing in one group', () => {
    expect(
      mql(
        'SELECT address.city, status AS s, COUNT(*) FROM c GROUP BY address.city, s ORDER BY 3 DESC',
      ),
    ).toBe(
      "db.c.aggregate([ { $group: { _id: { address_city: { $ifNull: [ '$address.city', null ] }, s: { $ifNull: [ '$status', null ] } }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $project: { _id: 0, 'address.city': '$_id.address_city', s: '$_id.s', count: '$count' } } ])",
    );
    // GROUP BY by position and by a column that is not selected.
    expect(mql('SELECT status, COUNT(*) n FROM c GROUP BY 1, region')).toBe(
      "db.c.aggregate([ { $group: { _id: { status: { $ifNull: [ '$status', null ] }, region: { $ifNull: [ '$region', null ] } }, n: { $sum: 1 } } }, { $project: { _id: 0, status: '$_id.status', n: '$n' } } ])",
    );
  });

  it('counts non-null values and distinct values', () => {
    expect(
      mql(
        'SELECT k, COUNT(x), COUNT(DISTINCT y) AS dy, SUM(DISTINCT z), AVG(DISTINCT w) FROM t GROUP BY k',
      ),
    ).toBe(
      "db.t.aggregate([ { $group: { _id: '$k', count_x: { $sum: { $cond: [ { $eq: [ { $ifNull: [ '$x', null ] }, null ] }, 0, 1 ] } }, dy: { $addToSet: '$y' }, sum_distinct_z: { $addToSet: '$z' }, avg_distinct_w: { $addToSet: '$w' } } }, { $set: { dy: { $size: { $setDifference: [ '$dy', [ null ] ] } }, sum_distinct_z: { $sum: '$sum_distinct_z' }, avg_distinct_w: { $avg: '$avg_distinct_w' } } }, { $project: { _id: 0, k: '$_id', count_x: '$count_x', dy: '$dy', sum_distinct_z: '$sum_distinct_z', avg_distinct_w: '$avg_distinct_w' } } ])",
    );
    expect(mql('SELECT k, COUNT(1), COUNT(NULL), SUM(2) FROM t GROUP BY k')).toBe(
      "db.t.aggregate([ { $group: { _id: '$k', count: { $sum: 1 }, count_2: { $sum: 0 }, sum: { $sum: 2 } } }, { $project: { _id: 0, k: '$_id', count: '$count', count_2: '$count_2', sum: '$sum' } } ])",
    );
  });

  it('returns one row for aggregates without GROUP BY, even over no documents', () => {
    expect(mql("SELECT COUNT(*) AS n, AVG(x) FROM t WHERE s = 'none'")).toBe(
      "db.t.aggregate([ { $match: { s: 'none' } }, { $facet: { rows: [ { $group: { _id: null, n: { $sum: 1 }, avg_x: { $avg: '$x' } } } ] } }, { $replaceWith: { $ifNull: [ { $first: '$rows' }, { n: 0, avg_x: null } ] } }, { $project: { _id: 0, n: '$n', avg_x: '$avg_x' } } ])",
    );
    expect(mql('SELECT COUNT(DISTINCT a) FROM t')).toBe(
      "db.t.aggregate([ { $facet: { rows: [ { $group: { _id: null, count_distinct_a: { $addToSet: '$a' } } }, { $set: { count_distinct_a: { $size: { $setDifference: [ '$count_distinct_a', [ null ] ] } } } } ] } }, { $replaceWith: { $ifNull: [ { $first: '$rows' }, { count_distinct_a: 0 } ] } }, { $project: { _id: 0, count_distinct_a: '$count_distinct_a' } } ])",
    );
  });

  it('filters groups with HAVING on aggregates, keys and aliases', () => {
    expect(
      mql(
        "SELECT status, COUNT(*) AS n FROM orders WHERE qty > 0 GROUP BY status HAVING COUNT(*) > 1 AND status <> 'X' AND MAX(qty) >= 10 ORDER BY SUM(qty) DESC LIMIT 3",
      ),
    ).toBe(
      "db.orders.aggregate([ { $match: { qty: { $gt: 0 } } }, { $group: { _id: '$status', n: { $sum: 1 }, max_qty: { $max: '$qty' }, sum_qty: { $sum: '$qty' } } }, { $match: { n: { $gt: 1 }, _id: { $nin: [ 'X', null ] }, max_qty: { $gte: 10 } } }, { $sort: { sum_qty: -1 } }, { $limit: 3 }, { $project: { _id: 0, status: '$_id', n: '$n' } } ])",
    );
    expect(mql('SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING n > 5')).toBe(
      "db.orders.aggregate([ { $group: { _id: '$status', n: { $sum: 1 } } }, { $match: { n: { $gt: 5 } } }, { $project: { _id: 0, status: '$_id', n: '$n' } } ])",
    );
    expect(mql('SELECT COUNT(*) AS n FROM t HAVING COUNT(*) > 0')).toBe(
      "db.t.aggregate([ { $facet: { rows: [ { $group: { _id: null, n: { $sum: 1 } } } ] } }, { $replaceWith: { $ifNull: [ { $first: '$rows' }, { n: 0 } ] } }, { $match: { n: { $gt: 0 } } }, { $project: { _id: 0, n: '$n' } } ])",
    );
  });

  it('translates DISTINCT with a $group', () => {
    expect(mql('SELECT DISTINCT status FROM t ORDER BY status DESC LIMIT 5 OFFSET 5')).toBe(
      "db.t.aggregate([ { $group: { _id: '$status' } }, { $sort: { _id: -1 } }, { $skip: 5 }, { $limit: 5 }, { $project: { _id: 0, status: '$_id' } } ])",
    );
    expect(mql("SELECT DISTINCT a, b.c AS bc, 'k' AS kind FROM t WHERE a > 1")).toBe(
      "db.t.aggregate([ { $match: { a: { $gt: 1 } } }, { $group: { _id: { a: { $ifNull: [ '$a', null ] }, bc: { $ifNull: [ '$b.c', null ] } } } }, { $project: { _id: 0, a: '$_id.a', bc: '$_id.bc', kind: { $literal: 'k' } } } ])",
    );
    // DISTINCT is a no-op when every group key is selected.
    expect(mql('SELECT DISTINCT status, COUNT(*) FROM t GROUP BY status')).toBe(
      mql('SELECT status, COUNT(*) FROM t GROUP BY status'),
    );
  });

  it('joins with $lookup and $unwind', () => {
    expect(
      mql('SELECT c.name, o.total FROM customers c JOIN orders o ON o.customerId = c._id'),
    ).toBe(
      "db.customers.aggregate([ { $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o' } }, { $unwind: '$o' }, { $project: { name: 1, 'o.total': 1, _id: 0 } } ])",
    );
    expect(
      mql(
        "SELECT * FROM customers c LEFT OUTER JOIN orders o ON c._id = o.customerId AND o.status = 'A' AND o.qty > o.min WHERE c.active AND o._id IS NULL",
      ),
    ).toBe(
      "db.customers.aggregate([ { $match: { active: true } }, { $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', pipeline: [ { $match: { status: 'A', qty: { $ne: null }, min: { $ne: null }, $expr: { $gt: [ '$qty', '$min' ] } } } ], as: 'o' } }, { $unwind: { path: '$o', preserveNullAndEmptyArrays: true } }, { $match: { 'o._id': null } } ])",
    );
    expect(
      mql('SELECT * FROM a INNER JOIN b ON a.x = b.x AND b.y = a.info.y AND a._id = b.aid'),
    ).toBe(
      "db.a.aggregate([ { $lookup: { from: 'b', let: { x: '$x', info_y: '$info.y', id: '$_id' }, pipeline: [ { $match: { $expr: { $and: [ { $eq: [ '$x', '$$x' ] }, { $eq: [ '$y', '$$info_y' ] }, { $eq: [ '$aid', '$$id' ] } ] } } } ], as: 'b' } }, { $unwind: '$b' } ])",
    );
  });

  it('chains joins, sorts, pages and groups after them', () => {
    expect(
      mql(
        'SELECT c.name, p.title FROM customers c JOIN orders o ON o.cid = c._id JOIN products p ON p._id = o.pid WHERE o.qty > 1 AND c.vip ORDER BY p.title LIMIT 5 OFFSET 10',
      ),
    ).toBe(
      "db.customers.aggregate([ { $match: { vip: true } }, { $lookup: { from: 'orders', localField: '_id', foreignField: 'cid', as: 'o' } }, { $unwind: '$o' }, { $lookup: { from: 'products', localField: 'o.pid', foreignField: '_id', as: 'p' } }, { $unwind: '$p' }, { $match: { 'o.qty': { $gt: 1 } } }, { $sort: { 'p.title': 1 } }, { $skip: 10 }, { $limit: 5 }, { $project: { name: 1, 'p.title': 1, _id: 0 } } ])",
    );
    expect(
      mql(
        'SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent FROM customers c LEFT JOIN orders o ON c._id = o.cid GROUP BY c.name ORDER BY spent DESC',
      ),
    ).toBe(
      "db.customers.aggregate([ { $lookup: { from: 'orders', localField: '_id', foreignField: 'cid', as: 'o' } }, { $unwind: { path: '$o', preserveNullAndEmptyArrays: true } }, { $group: { _id: '$name', orders: { $sum: 1 }, spent: { $sum: '$o.total' } } }, { $sort: { spent: -1 } }, { $project: { _id: 0, name: '$_id', orders: '$orders', spent: '$spent' } } ])",
    );
    expect(mql('SELECT c.* FROM customers c JOIN orders o ON o.cid = c._id')).toBe(
      "db.customers.aggregate([ { $lookup: { from: 'orders', localField: '_id', foreignField: 'cid', as: 'o' } }, { $unwind: '$o' }, { $project: { o: 0 } } ])",
    );
  });

  it('returns the pipeline as data with text that parses back to it', () => {
    const translation: SqlTranslation = sqlToMql(
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC',
    );
    expect(translation.kind).toBe('aggregate');
    if (translation.kind !== 'aggregate') return;
    expect(translation.columns).toEqual(['status', 'n']);
    expect(translation.text).toBe(
      "db.orders.aggregate([\n  { $group: { _id: '$status', n: { $sum: 1 } } },\n  { $sort: { n: -1 } },\n  { $project: { _id: 0, status: '$_id', n: '$n' } }\n])",
    );
    const body = translation.text.slice('db.orders.aggregate('.length, -1);
    expect(toEjson(parseShellPipeline(body))).toBe(toEjson(translation.pipeline));
    expect(formatShellInline(translation.pipeline[1]!)).toBe('{ $sort: { n: -1 } }');
  });
});

describe('SQL errors', () => {
  const cases: [sql: string, code: string, at: string, reason: RegExp][] = [
    ['', 'VALIDATION_FAILED', '', /Enter a SELECT/],
    ['SELECT', 'VALIDATION_FAILED', '', /Expected a column/],
    ['SELECT a', 'VALIDATION_FAILED', '', /Expected FROM/],
    ['SELECT a FROM', 'VALIDATION_FAILED', '', /Expected a collection name/],
    ["SELECT a FROM t WHERE b = 'x", 'VALIDATION_FAILED', "'x", /never closed/],
    ['SELECT "a FROM t', 'VALIDATION_FAILED', '"a FROM t', /never closed/],
    ['SELECT a FROM t /* x', 'VALIDATION_FAILED', '/* x', /comment is never closed/],
    ['SELECT 12abc FROM t', 'VALIDATION_FAILED', '12abc', /not a number/],
    ['SELECT a FROM t WHERE', 'VALIDATION_FAILED', '', /Expected a value/],
    ['SELECT a FROM t WHERE a = NULL', 'VALIDATION_FAILED', 'a = NULL', /never true/],
    ['SELECT a FROM t WHERE a IN (1, NULL)', 'VALIDATION_FAILED', 'NULL', /never matches/],
    ['SELECT a FROM t WHERE a == 1', 'VALIDATION_FAILED', '==', /==/],
    ['SELECT select FROM t', 'VALIDATION_FAILED', 'select', /keyword SELECT/],
    [
      "SELECT * FROM t WHERE d = DATE '2024-02-30'",
      'VALIDATION_FAILED',
      "'2024-02-30'",
      /not a date/,
    ],
    ["SELECT * FROM t WHERE i = ObjectId('xyz')", 'VALIDATION_FAILED', "'xyz'", /24 hexadecimal/],
    ["SELECT * FROM t WHERE a LIKE 'x\\'", 'VALIDATION_FAILED', "'x\\'", /escape character/],
    ["SELECT * FROM t WHERE a LIKE 'x' ESCAPE 'ab'", 'VALIDATION_FAILED', "'ab'", /one character/],
    ['SELECT a, t.a FROM t', 'VALIDATION_FAILED', 't.a', /selected twice/],
    ['SELECT a AS x, b AS x FROM t', 'VALIDATION_FAILED', 'b AS x', /selected twice/],
    ['SELECT a AS "x.y" FROM t', 'VALIDATION_FAILED', '"x.y"', /cannot contain "\."/],
    ['SELECT a, COUNT(*) FROM t', 'VALIDATION_FAILED', 'a', /GROUP BY/],
    ['SELECT a, b FROM t GROUP BY a', 'VALIDATION_FAILED', 'b', /must appear in GROUP BY/],
    ['SELECT * FROM t WHERE COUNT(*) > 1', 'VALIDATION_FAILED', 'COUNT(*)', /not allowed in WHERE/],
    ['SELECT SUM(COUNT(*)) FROM t', 'VALIDATION_FAILED', 'COUNT(*)', /cannot be nested/],
    ['SELECT DISTINCT a FROM t ORDER BY b', 'VALIDATION_FAILED', 'b', /DISTINCT/],
    ['SELECT a FROM t ORDER BY 2', 'VALIDATION_FAILED', '2', /not in the select list/],
    ['SELECT * FROM t ORDER BY 1', 'VALIDATION_FAILED', '1', /needs a select list/],
    ['SELECT * FROM t GROUP BY a', 'NOT_SUPPORTED', '*', /cannot be combined/],
    ['SELECT a FROM t t JOIN u t ON t.a = t.b', 'VALIDATION_FAILED', 'u t', /used twice/],
    [
      'SELECT * FROM t JOIN u ON t.a = u.b JOIN v ON u.a = w.b',
      'NOT_SUPPORTED',
      'u.a = w.b',
      /ON can only/,
    ],
    [
      'SELECT * FROM t JOIN u ON u.a = v.b JOIN v ON v.a = t.a',
      'VALIDATION_FAILED',
      'v.b',
      /joined later/,
    ],
    ['SELECT a FROM t LIMIT 1.5', 'VALIDATION_FAILED', '1.5', /whole number/],
    ['SELECT a FROM t WHERE $x = 1', 'NOT_SUPPORTED', '$', /Parameters/],
    ['SELECT a FROM t WHERE `$x` = 1', 'NOT_SUPPORTED', '`$x`', /starting with \$/],
    ['SELECT a FROM t; SELECT b FROM u', 'NOT_SUPPORTED', 'SELECT b', /one statement/],
    ['SELECT a FROM (SELECT a FROM t)', 'NOT_SUPPORTED', '(', /Subqueries/],
    ['SELECT a FROM t WHERE a IN (SELECT b FROM u)', 'NOT_SUPPORTED', 'SELECT b', /Subqueries/],
    ['SELECT a FROM t WHERE EXISTS (SELECT 1)', 'NOT_SUPPORTED', 'EXISTS', /Subqueries/],
    ['SELECT (SELECT 1) FROM t', 'NOT_SUPPORTED', 'SELECT 1', /Subqueries/],
    ['SELECT a FROM t UNION SELECT a FROM u', 'NOT_SUPPORTED', 'UNION', /UNION/],
    ['SELECT a FROM t UNION ALL SELECT a FROM u', 'NOT_SUPPORTED', 'UNION', /UNION/],
    ['SELECT a FROM t INTERSECT SELECT a FROM u', 'NOT_SUPPORTED', 'INTERSECT', /INTERSECT/],
    [
      'SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t',
      'NOT_SUPPORTED',
      'ROW_NUMBER',
      /function ROW_NUMBER/,
    ],
    ['SELECT COUNT(*) OVER () FROM t', 'NOT_SUPPORTED', 'OVER', /Window functions/],
    ['SELECT UPPER(name) FROM t', 'NOT_SUPPORTED', 'UPPER', /function UPPER\(\)/],
    ['SELECT a FROM t WHERE LOWER(a) = 1', 'NOT_SUPPORTED', 'LOWER', /function LOWER/],
    ['SELECT a + 1 FROM t', 'NOT_SUPPORTED', '+', /Arithmetic/],
    ['SELECT a FROM t WHERE -a > 1', 'NOT_SUPPORTED', '-', /Arithmetic/],
    ["SELECT a || 'x' FROM t", 'NOT_SUPPORTED', '||', /concatenation/],
    ['SELECT a::int FROM t', 'NOT_SUPPORTED', '::', /Casts/],
    ['SELECT CAST(a AS int) FROM t', 'NOT_SUPPORTED', 'CAST', /Casts/],
    ['SELECT CASE WHEN a THEN 1 END FROM t', 'NOT_SUPPORTED', 'CASE', /CASE/],
    ['SELECT a FROM t RIGHT JOIN u ON t.a = u.a', 'NOT_SUPPORTED', 'RIGHT', /RIGHT JOIN/],
    ['SELECT a FROM t FULL OUTER JOIN u ON t.a = u.a', 'NOT_SUPPORTED', 'FULL', /FULL JOIN/],
    ['SELECT a FROM t CROSS JOIN u', 'NOT_SUPPORTED', 'CROSS', /CROSS JOIN/],
    ['SELECT a FROM t NATURAL JOIN u', 'NOT_SUPPORTED', 'NATURAL', /NATURAL JOIN/],
    ['SELECT a FROM t JOIN u USING (a)', 'NOT_SUPPORTED', 'USING', /USING/],
    ['SELECT a FROM t, u', 'NOT_SUPPORTED', ',', /Comma-separated/],
    ['SELECT a FROM t JOIN u ON t.a > u.b', 'NOT_SUPPORTED', 't.a', /ON can only/],
    ['SELECT a FROM t JOIN u ON a = b', 'NOT_SUPPORTED', 'a = b', /ON can only/],
    ['SELECT a FROM t JOIN u ON u.x = 5', 'NOT_SUPPORTED', 'u.x = 5', /ON needs an equality/],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'NOT_SUPPORTED', 'WITH', /WITH/],
    ['INSERT INTO t VALUES (1)', 'NOT_SUPPORTED', 'INSERT', /Only SELECT/],
    ['DELETE FROM t', 'NOT_SUPPORTED', 'DELETE', /Only SELECT/],
    ['SELECT a FROM t LIMIT 0', 'NOT_SUPPORTED', '0', /LIMIT 0/],
    ['SELECT DISTINCT * FROM t', 'NOT_SUPPORTED', '*', /cannot be combined/],
    ['SELECT DISTINCT ON (a) a FROM t', 'NOT_SUPPORTED', 'ON', /DISTINCT ON/],
    ['SELECT TOP 5 a FROM t', 'NOT_SUPPORTED', 'TOP', /TOP/],
    [
      'SELECT a FROM t ORDER BY a ASC NULLS LAST',
      'NOT_SUPPORTED',
      'a ASC NULLS LAST',
      /NULLS LAST/,
    ],
    ['SELECT a FROM t ORDER BY 1.5', 'NOT_SUPPORTED', '1.5', /constant/],
    ["SELECT a FROM t WHERE a REGEXP 'x'", 'NOT_SUPPORTED', 'REGEXP', /REGEXP/],
    ['SELECT a FROM t WHERE a IS DISTINCT FROM b', 'NOT_SUPPORTED', 'DISTINCT', /IS DISTINCT FROM/],
    ['SELECT a FROM t WHERE a = ?', 'NOT_SUPPORTED', '?', /Parameters/],
    ['SELECT o.* FROM t JOIN o ON o.a = t.a', 'NOT_SUPPORTED', 'o.*', /o\.\* is not supported/],
    ['SELECT x.* FROM t', 'VALIDATION_FAILED', 'x.*', /not a table/],
    ['SELECT a FROM t JOIN fs.files ON t.a = fs.files.b', 'VALIDATION_FAILED', 'fs.files', /alias/],
    ['SELECT SUM(*) FROM t', 'VALIDATION_FAILED', '*', /SUM\(\*\)/],
    ['SELECT COUNT(DISTINCT 1) FROM t', 'NOT_SUPPORTED', 'COUNT(DISTINCT 1)', /needs a column/],
    ['SELECT a FROM t GROUP BY 1.5', 'NOT_SUPPORTED', '1.5', /constant/],
    [
      'SELECT 1 FROM t GROUP BY COUNT(*)',
      'VALIDATION_FAILED',
      'COUNT(*)',
      /not allowed in GROUP BY/,
    ],
  ];

  it.each(cases)('%s', (sql, code, at, reason) => {
    const error = failure(sql);
    expect(error.code).toBe(code);
    expect(error.reason).toMatch(reason);
    const offset = at === '' ? sql.length : sql.indexOf(at);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(error.offset).toBe(offset);
    expect(error.end).toBeGreaterThanOrEqual(error.offset);
    expect(error.position).toBe(error.offset);
    expect(error.message).toMatch(/\(line \d+, column \d+\)$/);
    expect(error).toBeInstanceOf(JoineryError);
  });

  it('locates errors by line and column and covers the whole bad range', () => {
    const error = failure('SELECT a\nFROM t\nWHERE UPPER(a) = 1');
    expect([error.line, error.column]).toEqual([3, 7]);
    expect(error.end - error.offset).toBe('UPPER'.length);
    const unclosed = failure("SELECT 'abc");
    expect(unclosed.end).toBe("SELECT 'abc".length);
  });

  it('fails on nesting beyond the limit instead of overflowing the stack', () => {
    const deep = `SELECT * FROM t WHERE ${'('.repeat(5000)}a = 1${')'.repeat(5000)}`;
    expect(failure(deep).reason).toMatch(/nested too deeply/);
    expect(failure(`SELECT * FROM t WHERE ${'NOT '.repeat(300)}a`).reason).toMatch(
      /nested too deeply/,
    );
    expect(sqlToMql(`SELECT * FROM t WHERE ${'NOT '.repeat(10)}a`, { maxDepth: 10 }).kind).toBe(
      'find',
    );
  });
});
