import { schemaSnapshotSchema } from '@joinery/core';
import {
  buildCatalog,
  complete,
  signatureHelp,
  type CompletionItem,
  type CompletionResult,
} from '@joinery/sql-tools';
import type { languages } from 'monaco-editor/editor';
import { describe, expect, it } from 'vitest';

import {
  ITEM_KINDS,
  SHOW_PARAMETERS,
  toCompletionList,
  toSignatureHelp,
  type EditorPosition,
  type MonacoEnums,
} from '../src/renderer/src/lib/completion-mapping';

/**
 * Completion results as Monaco takes them (spec §6): the engine's [from, to) becomes insert and
 * replace ranges, kinds become icons, snippets insert as snippets, and `incomplete` passes on.
 */

// Monaco's own values (monaco.d.ts); Monaco itself does not load outside a browser.
const KIND_VALUES = [
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Struct',
  'Interface',
  'Module',
  'Property',
  'Event',
  'Operator',
  'Unit',
  'Value',
  'Constant',
  'Enum',
  'EnumMember',
  'Keyword',
  'Text',
  'Color',
  'File',
  'Reference',
  'Customcolor',
  'Folder',
  'TypeParameter',
  'User',
  'Issue',
  'Tool',
  'Snippet',
] as const;

const enums: MonacoEnums = {
  CompletionItemKind: Object.fromEntries(
    KIND_VALUES.map((name, value) => [name, value]),
  ) as unknown as typeof languages.CompletionItemKind,
  CompletionItemInsertTextRule: {
    None: 0,
    KeepWhitespace: 1,
    InsertAsSnippet: 4,
  } as unknown as typeof languages.CompletionItemInsertTextRule,
};

/** A text model's offset → position, as Monaco computes it (1-based lines and columns). */
function modelOf(text: string) {
  return {
    getPositionAt(offset: number): EditorPosition {
      const before = text.slice(0, offset).split('\n');
      return { lineNumber: before.length, column: before.at(-1)!.length + 1 };
    },
  };
}

function at(text: string, offset: number) {
  const model = modelOf(text);
  return { model, position: model.getPositionAt(offset) };
}

const catalog = buildCatalog([
  schemaSnapshotSchema.parse({
    engine: 'postgres',
    database: 'shop',
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: 'orders',
            columns: [
              { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
              { name: 'total', ordinal: 2, dataType: 'numeric', nullable: true, comment: 'Gross' },
            ],
          },
        ],
      },
    ],
    capturedAt: '2026-09-29T10:00:00.000Z',
  }),
]);

function item(overrides: Partial<CompletionItem> & Pick<CompletionItem, 'kind'>): CompletionItem {
  return { label: 'x', insertText: 'x', sortText: '0', ...overrides };
}

describe('toCompletionList', () => {
  it('maps the word range to insert and replace ranges on the cursor line', () => {
    const text = 'SELECT 1;\nSELECT * FROM ordxx';
    const offset = text.length - 2; // between "ord" and "xx"
    const result = complete(text, offset, 'postgres', catalog);
    expect(result.from).toBe(text.indexOf('ordxx'));
    const { model, position } = at(text, offset);
    const list = toCompletionList(result, model, position, enums);
    const orders = list.suggestions.find((s) => s.label === 'orders');
    expect(orders).toMatchObject({
      kind: enums.CompletionItemKind.Struct,
      insertText: 'orders',
      detail: 'table · public',
      range: {
        insert: { startLineNumber: 2, startColumn: 15, endLineNumber: 2, endColumn: 18 },
        replace: { startLineNumber: 2, startColumn: 15, endLineNumber: 2, endColumn: 20 },
      },
    });
    expect(orders?.sortText).toBe(result.items.find((i) => i.label === 'orders')?.sortText);
    expect(list.incomplete).toBe(false);
  });

  it('carries columns with their types and comments', () => {
    const text = 'SELECT * FROM orders WHERE ';
    const result = complete(text, text.length, 'postgres', catalog);
    const { model, position } = at(text, text.length);
    const list = toCompletionList(result, model, position, enums, ' ');
    const total = list.suggestions.find((s) => s.label === 'total');
    expect(total).toMatchObject({
      kind: enums.CompletionItemKind.Field,
      detail: 'numeric',
      documentation: 'public.orders — Gross',
    });
  });

  it('inserts snippets as snippets and shows parameters after a call', () => {
    const text = 'SELECT lp';
    const result = complete(text, text.length, 'postgres', catalog, {
      snippets: [{ prefix: 'lpq', body: 'SELECT ${1:x}', description: 'Mine' }],
    });
    const { model, position } = at(text, text.length);
    const list = toCompletionList(result, model, position, enums);
    const lpad = list.suggestions.find((s) => s.label === 'LPAD');
    expect(lpad).toMatchObject({
      kind: enums.CompletionItemKind.Function,
      insertText: 'LPAD($0)',
      insertTextRules: enums.CompletionItemInsertTextRule.InsertAsSnippet,
      command: SHOW_PARAMETERS,
    });
    const snippet = list.suggestions.find((s) => s.label === 'lpq');
    expect(snippet).toMatchObject({
      kind: enums.CompletionItemKind.Snippet,
      insertText: 'SELECT ${1:x}',
      insertTextRules: enums.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: 'Mine',
    });
    expect(snippet?.command).toBeUndefined();
  });

  it('passes filter text for quoted identifiers and the incomplete flag', () => {
    const result: CompletionResult = {
      items: [
        item({
          kind: 'table',
          label: 'Order Lines',
          insertText: '"Order Lines"',
          filterText: '"Order Lines"',
        }),
      ],
      from: 14,
      to: 16,
      incomplete: true,
    };
    const text = 'SELECT * FROM "O';
    const { model, position } = at(text, text.length);
    const list = toCompletionList(result, model, position, enums);
    expect(list.incomplete).toBe(true);
    expect(list.suggestions[0]).toMatchObject({
      filterText: '"Order Lines"',
      insertText: '"Order Lines"',
    });
    expect(list.suggestions[0]).not.toHaveProperty('insertTextRules');
  });

  it('gives every item kind an icon', () => {
    const kinds = Object.keys(ITEM_KINDS) as CompletionItem['kind'][];
    const result: CompletionResult = {
      items: kinds.map((kind) => item({ kind })),
      from: 0,
      to: 0,
      incomplete: false,
    };
    const { model, position } = at('', 0);
    const icons = toCompletionList(result, model, position, enums).suggestions.map((s) => s.kind);
    expect(icons).toEqual(kinds.map((kind) => enums.CompletionItemKind[ITEM_KINDS[kind]]));
    expect(icons.every((icon) => typeof icon === 'number')).toBe(true);
    expect(icons).toContain(enums.CompletionItemKind.Keyword);
  });

  it('opens after a space or ( only when the metadata has something to offer', () => {
    const { model, position } = at('SELECT 1 ', 9);
    const keywordsOnly: CompletionResult = {
      items: [item({ kind: 'keyword', label: 'FROM' }), item({ kind: 'function', label: 'NOW' })],
      from: 9,
      to: 9,
      incomplete: true,
    };
    expect(toCompletionList(keywordsOnly, model, position, enums, ' ')).toEqual({
      suggestions: [],
      incomplete: false,
    });
    expect(toCompletionList(keywordsOnly, model, position, enums, '(').suggestions).toEqual([]);
    // Typed or invoked, and after `.`, keywords are shown as usual.
    expect(toCompletionList(keywordsOnly, model, position, enums).suggestions).toHaveLength(2);
    expect(toCompletionList(keywordsOnly, model, position, enums, '.').suggestions).toHaveLength(2);
    const withTables = {
      ...keywordsOnly,
      items: [...keywordsOnly.items, item({ kind: 'table' })],
    };
    expect(toCompletionList(withTables, model, position, enums, ' ').suggestions).toHaveLength(3);
  });

  it('falls back to an empty range at the cursor when the word spans lines', () => {
    const text = 'SELECT "a\nb';
    const result: CompletionResult = {
      items: [item({ kind: 'column' })],
      from: 7,
      to: text.length,
      incomplete: false,
    };
    const { model, position } = at(text, text.length);
    expect(toCompletionList(result, model, position, enums).suggestions[0]?.range).toEqual({
      startLineNumber: 2,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 2,
    });
  });
});

describe('toSignatureHelp', () => {
  it('passes signatures with parameter label offsets and the active argument', () => {
    const text = 'SELECT lpad(name, 10, ';
    const help = signatureHelp(text, text.length, 'postgres', catalog)!;
    const mapped = toSignatureHelp(help);
    expect(mapped.activeParameter).toBe(2);
    expect(mapped.activeSignature).toBe(help.activeSignature);
    const signature = mapped.signatures[mapped.activeSignature]!;
    expect(signature.label).toMatch(/^lpad\(/);
    const [start, end] = signature.parameters[2]!.label as [number, number];
    expect(signature.label.slice(start, end)).toContain('fill');
  });
});
