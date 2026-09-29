import {
  completeConsole,
  type CompletionKind,
  type ConsoleCompletionOptions,
} from '@joinery/search-tools';

import { monaco } from '../../lib/monaco';

/**
 * The console language in Monaco (spec §11): Kibana console highlighting (request lines, JSON
 * bodies, comments, triple-quoted strings) and autocomplete from @joinery/search-tools, which
 * knows the endpoints and body keys of the open Elasticsearch API specification. The response
 * pane uses the same language for its JSON.
 */

export const CONSOLE_LANGUAGE = 'joinery-es-console';

/** Model URI → the completion options of the console that owns it (index names, distribution). */
const consoles = new Map<string, () => ConsoleCompletionOptions>();

export function bindConsoleModel(
  model: monaco.editor.ITextModel,
  options: () => ConsoleCompletionOptions,
): void {
  consoles.set(model.uri.toString(), options);
}

export function unbindConsoleModel(model: monaco.editor.ITextModel): void {
  consoles.delete(model.uri.toString());
}

const KINDS: Readonly<Record<CompletionKind, monaco.languages.CompletionItemKind>> = {
  method: monaco.languages.CompletionItemKind.Keyword,
  endpoint: monaco.languages.CompletionItemKind.Function,
  index: monaco.languages.CompletionItemKind.Folder,
  parameter: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Property,
  value: monaco.languages.CompletionItemKind.Value,
};

let registered = false;

/** Registers the language, its tokenizer and its completion provider (once). */
export function registerConsoleLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: CONSOLE_LANGUAGE });
  monaco.languages.setLanguageConfiguration(CONSOLE_LANGUAGE, {
    comments: { lineComment: '#', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
  });
  monaco.languages.setMonarchTokensProvider(CONSOLE_LANGUAGE, {
    tokenizer: {
      root: [
        [
          /(GET|POST|PUT|DELETE|HEAD|PATCH|get|post|put|delete|head|patch)(?=[ \t]+\S)/,
          'keyword',
          '@url',
        ],
        [/#.*$/, 'comment'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"""/, 'string', '@triple'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword.json'],
        [/[{}[\]]/, '@brackets'],
        [/[,:]/, 'delimiter'],
      ],
      url: [
        [/[ \t]+(?:#|\/\/).*$/, 'comment', '@pop'],
        [/\?[^ \t]*/, 'variable'],
        [/[^?\s]+/, 'string.link'],
        [/[ \t]+/, ''],
        [/$/, '', '@pop'],
      ],
      comment: [
        [/\*\//, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      triple: [
        [/"""/, 'string', '@pop'],
        [/./, 'string'],
      ],
    },
  });
  monaco.languages.registerCompletionItemProvider(CONSOLE_LANGUAGE, {
    triggerCharacters: ['/', '"', '?', '&', '_', ' '],
    provideCompletionItems(model, position) {
      const options = consoles.get(model.uri.toString())?.();
      if (!options) return { suggestions: [] };
      const result = completeConsole(model.getValue(), model.getOffsetAt(position), options);
      if (!result) return { suggestions: [] };
      const from = model.getPositionAt(result.from);
      const to = model.getPositionAt(result.to);
      // Suggestions replace text on one line.
      const range =
        from.lineNumber === to.lineNumber
          ? new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column)
          : new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            );
      return {
        suggestions: result.items.map((item, index) => ({
          label: item.label,
          kind: KINDS[item.kind],
          insertText: item.insertText,
          ...(item.snippet
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {}),
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
          sortText: String(index).padStart(5, '0'),
          range,
        })),
      };
    },
  });
}
