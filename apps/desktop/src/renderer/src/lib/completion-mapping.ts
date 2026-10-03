import type {
  CompletionItemKind as SqlItemKind,
  CompletionResult,
  SignatureHelp,
} from '@querybara/sql-tools';
import type { IRange, languages } from 'monaco-editor/editor';

/**
 * Turns the language service's answers into Monaco's shapes (spec §6): completion items with
 * their replace ranges, icons, snippets and sort/filter text, and signature help with parameter
 * label offsets. Monaco's enums are passed in, so this runs (and is tested) without Monaco.
 */

export interface MonacoEnums {
  readonly CompletionItemKind: typeof languages.CompletionItemKind;
  readonly CompletionItemInsertTextRule: typeof languages.CompletionItemInsertTextRule;
}

export interface EditorPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** The part of a Monaco text model the mapping needs. */
export interface PositionSource {
  getPositionAt(offset: number): EditorPosition;
}

/** Which Monaco icon each kind of item gets. */
export const ITEM_KINDS: Readonly<Record<SqlItemKind, keyof typeof languages.CompletionItemKind>> =
  {
    keyword: 'Keyword',
    database: 'Module',
    schema: 'Module',
    table: 'Struct',
    view: 'Interface',
    column: 'Field',
    function: 'Function',
    alias: 'Variable',
    join: 'Reference',
    snippet: 'Snippet',
    sequence: 'Constant',
    type: 'TypeParameter',
  };

/** Items that come from the connection's metadata rather than the dialect's word lists. */
const CATALOG_KINDS: ReadonlySet<SqlItemKind> = new Set([
  'table',
  'view',
  'column',
  'join',
  'alias',
  'schema',
  'database',
]);

/**
 * Trigger characters that open the list only when it has something from the metadata: after
 * a space or `(`, a list of keywords alone would only get in the way of typing.
 */
const QUIET_TRIGGERS: ReadonlySet<string> = new Set([' ', '(']);

/** Runs after accepting a call snippet, so its parameters show while the arguments are typed. */
export const SHOW_PARAMETERS = { id: 'editor.action.triggerParameterHints', title: 'Parameters' };

/**
 * A Monaco completion list for `result`, computed at `position`. The engine's [from, to) word
 * range becomes the insert (up to the cursor) and replace (the whole word) ranges.
 */
export function toCompletionList(
  result: CompletionResult,
  model: PositionSource,
  position: EditorPosition,
  enums: MonacoEnums,
  triggerCharacter?: string,
): languages.CompletionList {
  if (
    triggerCharacter !== undefined &&
    QUIET_TRIGGERS.has(triggerCharacter) &&
    !result.items.some((item) => CATALOG_KINDS.has(item.kind))
  ) {
    return { suggestions: [], incomplete: false };
  }
  const start = model.getPositionAt(result.from);
  const end = model.getPositionAt(result.to);
  const line = position.lineNumber;
  const range: IRange | languages.CompletionItemRanges =
    start.lineNumber === line && end.lineNumber === line && start.column <= position.column
      ? {
          insert: {
            startLineNumber: line,
            startColumn: start.column,
            endLineNumber: line,
            endColumn: position.column,
          },
          replace: {
            startLineNumber: line,
            startColumn: start.column,
            endLineNumber: line,
            endColumn: Math.max(end.column, position.column),
          },
        }
      : {
          startLineNumber: line,
          startColumn: position.column,
          endLineNumber: line,
          endColumn: position.column,
        };
  const suggestions = result.items.map((item): languages.CompletionItem => {
    const suggestion: languages.CompletionItem = {
      label: item.label,
      kind: enums.CompletionItemKind[ITEM_KINDS[item.kind]],
      insertText: item.insertText,
      sortText: item.sortText,
      range,
    };
    if (item.filterText !== undefined) suggestion.filterText = item.filterText;
    if (item.detail !== undefined) suggestion.detail = item.detail;
    if (item.documentation !== undefined) suggestion.documentation = item.documentation;
    if (item.isSnippet) {
      suggestion.insertTextRules = enums.CompletionItemInsertTextRule.InsertAsSnippet;
      if (item.kind === 'function' && item.insertText.endsWith('($0)')) {
        suggestion.command = SHOW_PARAMETERS;
      }
    }
    return suggestion;
  });
  return { suggestions, incomplete: result.incomplete };
}

/** Monaco signature help; parameters are [start, end] offsets into each signature's label. */
export function toSignatureHelp(help: SignatureHelp): languages.SignatureHelp {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      ...(signature.documentation === undefined ? {} : { documentation: signature.documentation }),
      parameters: signature.parameters.map((parameter) => ({
        label: [parameter.start, parameter.end] as [number, number],
      })),
    })),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  };
}
