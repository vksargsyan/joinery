import { QuerybaraError } from '@querybara/core';

import type { BatchParts } from './rows';
import { detectEncoding } from './text';
import type { SourceCell } from './types';
import {
  XmlParser,
  decodeXmlName,
  escapeXmlAttribute,
  escapeXmlText,
  type XmlHandler,
} from './xml';

/**
 * XML import (spec §12): rows are the elements at one path from the root (`/orders/order`),
 * repeated; the columns are
 * - the row element's attributes, named after them;
 * - its child elements, named after them: their text, or their inner markup when they hold
 *   elements of their own, so nothing is lost; a name repeated within a row gives `name_2`,
 *   `name_3`...; `xsi:nil="true"` is NULL, an empty element the empty string;
 * - attributes of child elements, as `child@attribute`;
 * - the row element's own text, when it has any, named after the row element.
 * Namespace declarations and `xsi:` attributes are not columns. Names are used as written
 * (with their prefix), with SQL/XML `_xHHHH_` escapes decoded, so Querybara's own XML export
 * reads back with its column names. Columns appear in order of first appearance.
 *
 * Without a path, `detectRowPaths` ranks the paths of a sample: record-like elements (with
 * attributes or leaf children) that repeat most, then those with more fields, then shallower
 * ones; a list of repeated leaf elements (`<ids><id>1</id><id>2</id></ids>`) when nothing
 * record-like repeats.
 */

export interface XmlReadOptions {
  /** The row elements' path from the root, e.g. `/export/table/row`; default detected. */
  readonly rowPath?: string;
  /** Longest value in characters (default 256 Mi). */
  readonly maxFieldLength?: number;
}

/** A path that could hold the rows, with how often it occurs in the sample. */
export interface XmlPathCandidate {
  readonly path: string;
  readonly count: number;
  /** Distinct attributes and leaf children seen on it. */
  readonly fields: number;
}

/**
 * The encoding of an XML document: a byte order mark (or UTF-16's zero bytes) first, then the
 * declaration's `encoding`, else UTF-8, or windows-1252 when the bytes are not valid UTF-8.
 */
export function xmlEncoding(head: Uint8Array, complete = false): string {
  const detected = detectEncoding(head, complete);
  if (detected.bom || detected.encoding.startsWith('utf-16')) return detected.encoding;
  const start = new TextDecoder('windows-1252').decode(head.subarray(0, 256));
  const declared = /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(start)?.[1];
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared).encoding;
    } catch {
      // An encoding TextDecoder does not know: fall back to detection.
    }
  }
  return detected.encoding;
}

function skipAttribute(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xsi:');
}

function isNil(attributes: readonly string[]): boolean {
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === 'xsi:nil') {
      const value = attributes[i + 1]!.trim();
      return value === 'true' || value === '1';
    }
  }
  return false;
}

/** Normalises a user-typed path: leading slash, no trailing slash, no blanks. */
export function normalizeRowPath(path: string): string {
  const parts = path
    .trim()
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The row path is empty',
      hint: 'Give the path of the repeated row element, such as /orders/order',
    });
  }
  return `/${parts.join('/')}`;
}

interface Frame {
  readonly path: string;
  hasChildren: boolean;
  readonly hasAttributes: boolean;
  readonly childCounts: Map<string, number>;
}

/** Collects path statistics for row path detection. */
class PathScanner implements XmlHandler {
  readonly counts = new Map<string, number>();
  readonly fields = new Map<string, Set<string>>();
  readonly records = new Set<string>();
  readonly repeatedLeaves = new Set<string>();
  private readonly stack: Frame[] = [];

  open(name: string, attributes: string[]): void {
    const parent = this.stack[this.stack.length - 1];
    const path = `${parent?.path ?? ''}/${name}`;
    if (parent !== undefined) {
      parent.hasChildren = true;
      parent.childCounts.set(name, (parent.childCounts.get(name) ?? 0) + 1);
    }
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
    let hasAttributes = false;
    for (let i = 0; i < attributes.length; i += 2) {
      if (skipAttribute(attributes[i]!)) continue;
      hasAttributes = true;
      this.field(path, `@${attributes[i]!}`);
    }
    this.stack.push({ path, hasChildren: false, hasAttributes, childCounts: new Map() });
  }

  close(name: string): void {
    const frame = this.stack.pop()!;
    const parent = this.stack[this.stack.length - 1];
    // A text-only child is a field of its parent; one with attributes is a record itself.
    if (!frame.hasChildren && !frame.hasAttributes && parent !== undefined) {
      this.field(parent.path, name);
      if ((parent.childCounts.get(name) ?? 0) >= 2) this.repeatedLeaves.add(frame.path);
    }
  }

  text(): void {}

  private field(path: string, name: string): void {
    let set = this.fields.get(path);
    if (set === undefined) {
      set = new Set();
      this.fields.set(path, set);
      this.records.add(path);
    }
    set.add(name);
  }
}

function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/**
 * Ranks the paths of an XML sample that could hold rows (see the module comment). A sample
 * cut short is read as far as it goes; a sample that is not XML throws.
 */
export function detectRowPaths(text: string, complete: boolean): XmlPathCandidate[] {
  const scanner = new PathScanner();
  const parser = new XmlParser(scanner);
  try {
    parser.push(text);
    if (complete) parser.end();
  } catch (error) {
    if (scanner.counts.size === 0) throw error;
  }
  const candidate = (path: string, fields: number): XmlPathCandidate => ({
    path,
    count: scanner.counts.get(path) ?? 0,
    fields,
  });
  const rank = (a: XmlPathCandidate, b: XmlPathCandidate): number =>
    b.count - a.count || b.fields - a.fields || depthOf(a.path) - depthOf(b.path);
  const records = [...scanner.records]
    .map((path) => candidate(path, scanner.fields.get(path)!.size))
    .sort(rank);
  const leaves = [...scanner.repeatedLeaves].map((path) => candidate(path, 1)).sort(rank);
  const ranked =
    records.length > 0 && records[0]!.count >= 2
      ? [...records, ...leaves]
      : leaves.length > 0
        ? [...leaves, ...records]
        : records;
  if (ranked.length === 0) {
    // Only a root element with text: the root is the one row.
    const root = [...scanner.counts.keys()][0];
    return root !== undefined ? [candidate(root, 1)] : [];
  }
  return ranked.slice(0, 20);
}

/** Most columns the rows may have (as many as an Excel worksheet). */
const MAX_COLUMNS = 16_384;

/** A column of the rows: how cells find it and what it is called. */
interface ChildState {
  column: number;
  nil: boolean;
  depth: number;
  hasElements: boolean;
  plain: string;
  markup: string;
}

/**
 * Turns the XML elements at the row path into rows (see the module comment). Feed it to an
 * XmlParser; rows collect in the parts passed to `take`.
 */
export class XmlRowBuilder implements XmlHandler {
  columns: string[] = [];
  private readonly keys = new Map<string, number>();
  private readonly taken = new Set<string>();
  private readonly maxLength: number;
  private readonly rowPath: string;
  private path: string[] = [];
  private depth = 0;
  private rowDepth = -1;
  private rowLine = 0;
  private rowName = '';
  private cells: SourceCell[] = [];
  private occurrences = new Map<string, number>();
  private child: ChildState | undefined;
  private rowText = '';
  private sawChild = false;
  private row = 0;
  private parts: BatchParts | undefined;

  constructor(rowPath: string, options: { maxFieldLength?: number } = {}) {
    this.rowPath = normalizeRowPath(rowPath);
    this.maxLength = options.maxFieldLength ?? 256 * 1024 * 1024;
  }

  /** Rows completed from now on go into `parts`. */
  collect(parts: BatchParts): void {
    this.parts = parts;
  }

  private column(key: string, name: string): number {
    let at = this.keys.get(key);
    if (at !== undefined) return at;
    if (this.columns.length >= MAX_COLUMNS) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `Invalid XML on line ${this.rowLine}: the rows have more than ${MAX_COLUMNS} columns`,
        hint: 'Choose the path of the repeated row elements',
      });
    }
    const base = decodeXmlName(name).trim() || `column${this.columns.length + 1}`;
    let unique = base;
    for (let n = 2; this.taken.has(unique.toLowerCase()); n++) unique = `${base}_${n}`;
    this.taken.add(unique.toLowerCase());
    at = this.columns.length;
    this.columns = [...this.columns, unique];
    this.keys.set(key, at);
    return at;
  }

  private set(column: number, value: SourceCell): void {
    while (this.cells.length < column) this.cells.push(null);
    this.cells[column] = value;
  }

  private tooLong(): never {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Invalid XML on line ${this.rowLine}: a value is longer than ${this.maxLength} characters`,
    });
  }

  open(name: string, attributes: string[], line: number): void {
    this.depth++;
    if (this.rowDepth < 0) {
      this.path.push(name);
      if (this.path.length === this.depth && `/${this.path.join('/')}` === this.rowPath) {
        this.rowDepth = this.depth;
        this.rowLine = line;
        this.rowName = name;
        this.cells = [];
        this.occurrences = new Map();
        this.rowText = '';
        this.sawChild = false;
        for (let i = 0; i < attributes.length; i += 2) {
          const attr = attributes[i]!;
          if (skipAttribute(attr)) continue;
          this.set(this.column(`@${attr}`, attr), attributes[i + 1]!);
        }
      }
      return;
    }
    const child = this.child;
    if (this.depth === this.rowDepth + 1) {
      this.sawChild = true;
      const seen = (this.occurrences.get(name) ?? 0) + 1;
      this.occurrences.set(name, seen);
      const key = seen === 1 ? name : `${name}#${seen}`;
      const label = seen === 1 ? name : `${name}_${seen}`;
      const column = this.column(`<${key}`, label);
      for (let i = 0; i < attributes.length; i += 2) {
        const attr = attributes[i]!;
        if (skipAttribute(attr)) continue;
        this.set(this.column(`<${key}@${attr}`, `${label}@${attr}`), attributes[i + 1]!);
      }
      this.child = {
        column,
        nil: isNil(attributes),
        depth: this.depth,
        hasElements: false,
        plain: '',
        markup: '',
      };
      return;
    }
    if (child !== undefined) {
      if (!child.hasElements) {
        // Markup is built only once the child turns out to hold elements.
        child.hasElements = true;
        child.markup = escapeXmlText(child.plain);
      }
      let tag = `<${name}`;
      for (let i = 0; i < attributes.length; i += 2) {
        tag += ` ${attributes[i]!}="${escapeXmlAttribute(attributes[i + 1]!)}"`;
      }
      child.markup += `${tag}>`;
    }
  }

  close(name: string): void {
    const depth = this.depth--;
    if (this.rowDepth < 0) {
      this.path.pop();
      return;
    }
    const child = this.child;
    if (depth === this.rowDepth) {
      const text = this.rowText;
      if (text.trim() !== '' || (!this.sawChild && this.cells.length === 0)) {
        this.set(this.column('#text', this.rowName), this.sawChild ? text.trim() : text);
      }
      if (this.parts !== undefined) {
        this.parts.rows.push(this.cells);
        this.parts.rowNumbers.push(++this.row);
        this.parts.lines.push(this.rowLine);
      }
      this.rowDepth = -1;
      this.path.pop();
      return;
    }
    if (child === undefined) return;
    if (depth === child.depth) {
      this.set(child.column, child.nil ? null : child.hasElements ? child.markup : child.plain);
      this.child = undefined;
    } else {
      child.markup += `</${name}>`;
    }
  }

  text(text: string): void {
    if (this.rowDepth < 0) return;
    const child = this.child;
    if (child === undefined) {
      if (this.depth === this.rowDepth) {
        this.rowText += text;
        if (this.rowText.length > this.maxLength) this.tooLong();
      }
      return;
    }
    if (child.hasElements) {
      child.markup += escapeXmlText(text);
      if (child.markup.length > this.maxLength) this.tooLong();
    } else {
      child.plain += text;
      if (child.plain.length > this.maxLength) this.tooLong();
    }
  }
}
