import {
  lookupCommand,
  type CommandArgument,
  type CommandCatalog,
  type CommandDoc,
} from './commands';
import { tokenizeLine } from './tokenizer';

/**
 * Autocomplete for the Redis CLI. The argument tree of a command (from COMMAND DOCS) is
 * compiled into a small NFA whose edges are either a keyword (a token such as `EX`, matched
 * case-insensitively) or a value (any word). Running the words typed so far through it gives
 * every place the command could be at, and their outgoing edges are the suggestions.
 */

export type SuggestionKind = 'command' | 'subcommand' | 'token' | 'argument';

export interface CommandSuggestion {
  readonly kind: SuggestionKind;
  /** Text to insert: the command or keyword; for `argument`, the placeholder name. */
  readonly text: string;
  /** e.g. the argument type ("integer", "key") or the command summary. */
  readonly detail?: string;
  /** The suggestion may be skipped (an optional argument). */
  readonly optional: boolean;
}

export interface CompletionResult {
  readonly suggestions: readonly CommandSuggestion[];
  /** The command the words resolve to, for inline docs. */
  readonly command?: CommandDoc;
  /** The words so far form a complete command (nothing more is required). */
  readonly complete: boolean;
  /** The first word is not a known command. */
  readonly unknownCommand: boolean;
}

type Edge =
  | { readonly kind: 'epsilon'; readonly to: number }
  | {
      readonly kind: 'keyword';
      readonly word: string;
      readonly optional: boolean;
      readonly to: number;
    }
  | {
      readonly kind: 'value';
      readonly arg: CommandArgument;
      readonly optional: boolean;
      readonly to: number;
    };

interface Nfa {
  readonly edges: Edge[][];
  readonly start: number;
  readonly accept: number;
}

class Builder {
  readonly edges: Edge[][] = [];

  state(): number {
    this.edges.push([]);
    return this.edges.length - 1;
  }

  edge(from: number, edge: Edge): void {
    this.edges[from]!.push(edge);
  }

  /** Adds `args` in sequence from `from`; returns the end state. */
  sequence(args: readonly CommandArgument[], from: number, optional: boolean): number {
    let at = from;
    for (const arg of args) at = this.argument(arg, at, optional);
    return at;
  }

  /** One argument with its optional / multiple flags; returns the end state. */
  argument(arg: CommandArgument, from: number, insideOptional: boolean): number {
    const optional = insideOptional || arg.optional;
    const start = this.state();
    this.edge(from, { kind: 'epsilon', to: start });
    let bodyStart = start;
    // A token that is not repeated comes once before the repeated part.
    if (arg.token && arg.type !== 'pure-token' && arg.multiple && !arg.multipleToken) {
      bodyStart = this.state();
      this.edge(start, { kind: 'keyword', word: arg.token, optional, to: bodyStart });
    }
    const withToken = !(arg.multiple && !arg.multipleToken);
    const bodyEnd = this.body(arg, bodyStart, optional, withToken);
    if (arg.multiple) this.edge(bodyEnd, { kind: 'epsilon', to: bodyStart });
    const end = this.state();
    this.edge(bodyEnd, { kind: 'epsilon', to: end });
    if (arg.optional) this.edge(start, { kind: 'epsilon', to: end });
    return end;
  }

  private body(arg: CommandArgument, from: number, optional: boolean, withToken: boolean): number {
    let at = from;
    if (arg.type === 'pure-token') {
      const next = this.state();
      this.edge(at, { kind: 'keyword', word: arg.token ?? arg.name, optional, to: next });
      return next;
    }
    if (arg.token && withToken) {
      const next = this.state();
      this.edge(at, { kind: 'keyword', word: arg.token, optional, to: next });
      at = next;
    }
    if (arg.type === 'oneof') {
      const end = this.state();
      for (const alternative of arg.arguments) {
        const altEnd = this.argument({ ...alternative, optional: false }, at, optional);
        this.edge(altEnd, { kind: 'epsilon', to: end });
      }
      return end;
    }
    if (arg.type === 'block') return this.sequence(arg.arguments, at, optional);
    const next = this.state();
    this.edge(at, { kind: 'value', arg, optional, to: next });
    return next;
  }
}

const nfaCache = new WeakMap<CommandDoc, Nfa>();

function nfaFor(doc: CommandDoc): Nfa {
  let nfa = nfaCache.get(doc);
  if (!nfa) {
    const builder = new Builder();
    const start = builder.state();
    const accept = builder.sequence(doc.arguments, start, false);
    nfa = { edges: builder.edges, start, accept };
    nfaCache.set(doc, nfa);
  }
  return nfa;
}

const MAX_STATES = 4096;

function closure(nfa: Nfa, states: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const stack = [...states];
  while (stack.length > 0 && out.size < MAX_STATES) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    for (const edge of nfa.edges[s]!) if (edge.kind === 'epsilon') stack.push(edge.to);
  }
  return out;
}

function step(nfa: Nfa, states: Set<number>, word: string): Set<number> {
  const upper = word.toUpperCase();
  const next: number[] = [];
  for (const s of states) {
    for (const edge of nfa.edges[s]!) {
      if (edge.kind === 'keyword' && edge.word.toUpperCase() === upper) next.push(edge.to);
      else if (edge.kind === 'value' && valueMatches(edge.arg, word)) next.push(edge.to);
    }
  }
  return closure(nfa, next);
}

function valueMatches(arg: CommandArgument, word: string): boolean {
  if (arg.type === 'integer') return /^[+-]?\d+$/.test(word);
  if (arg.type === 'double')
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?inf$|^\(/i.test(word);
  if (arg.type === 'unix-time') return /^\d+$/.test(word);
  return true;
}

function suggestionsAt(nfa: Nfa, states: Set<number>): CommandSuggestion[] {
  const seen = new Set<string>();
  const out: CommandSuggestion[] = [];
  // State ids follow the argument order, so suggestions come in documentation order.
  for (const s of [...states].sort((a, b) => a - b)) {
    for (const edge of nfa.edges[s]!) {
      if (edge.kind === 'keyword') {
        const key = `t:${edge.word.toUpperCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: 'token', text: edge.word, optional: edge.optional });
      } else if (edge.kind === 'value') {
        const text = edge.arg.displayText ?? edge.arg.name;
        const key = `a:${text}:${edge.arg.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: 'argument', text, detail: edge.arg.type, optional: edge.optional });
      }
    }
  }
  return out;
}

function startsWithCi(text: string, prefix: string): boolean {
  return text.toUpperCase().startsWith(prefix.toUpperCase());
}

/**
 * Suggests what may come next after the complete `words` typed so far, optionally narrowed to
 * a `partial` word being typed. With no words, suggests command names; after a container
 * command (CONFIG, CLIENT...), its subcommands; then keywords and argument placeholders from
 * the argument tree. Needs COMMAND DOCS for arguments; with only COMMAND INFO (Redis 6.2) it
 * completes command names.
 */
export function suggestNext(
  catalog: CommandCatalog,
  words: readonly string[],
  partial = '',
): CompletionResult {
  if (words.length === 0) {
    const suggestions = Object.values(catalog.commands)
      .filter((doc) => startsWithCi(doc.name, partial))
      .map((doc): CommandSuggestion => ({
        kind: 'command',
        text: doc.name,
        ...(doc.summary !== undefined ? { detail: doc.summary } : {}),
        optional: false,
      }));
    return { suggestions, complete: false, unknownCommand: false };
  }
  const found = lookupCommand(catalog, words);
  if (!found) return { suggestions: [], complete: false, unknownCommand: true };
  const { doc, consumed } = found;
  if (doc.subcommands.length > 0 && consumed === 1 && words.length === 1) {
    const suggestions = doc.subcommands
      .map((sub) => sub.name.slice(doc.name.length + 1))
      .filter((name) => startsWithCi(name, partial))
      .map((name): CommandSuggestion => {
        const summary = doc.subcommands.find((s) => s.name === `${doc.name} ${name}`)?.summary;
        return {
          kind: 'subcommand',
          text: name,
          ...(summary !== undefined ? { detail: summary } : {}),
          optional: false,
        };
      });
    return { suggestions, command: doc, complete: false, unknownCommand: false };
  }
  const nfa = nfaFor(doc);
  let states = closure(nfa, [nfa.start]);
  for (const word of words.slice(consumed)) {
    states = step(nfa, states, word);
    if (states.size === 0) break;
  }
  const suggestions = suggestionsAt(nfa, states).filter(
    (s) => s.kind === 'argument' || startsWithCi(s.text, partial),
  );
  // Without an argument tree (Redis 6.2), completeness comes from the arity.
  const complete =
    doc.arguments.length === 0 && doc.arity !== undefined
      ? doc.arity >= 0
        ? words.length === doc.arity
        : words.length >= -doc.arity
      : states.has(nfa.accept);
  return {
    suggestions: partial ? suggestions.filter((s) => s.kind === 'token') : suggestions,
    command: doc,
    complete,
    unknownCommand: false,
  };
}

export interface LineCompletion extends CompletionResult {
  /** UTF-16 range of the input the chosen suggestion replaces (the word under the cursor). */
  readonly replaceStart: number;
  readonly replaceEnd: number;
}

/**
 * Completion for a CLI input line with the cursor at `cursor` (UTF-16 offset): tokenizes the
 * text before the cursor like redis-cli, treats a word touching the cursor as the partial word,
 * and suggests from the command tree.
 */
export function completeLine(
  catalog: CommandCatalog,
  line: string,
  cursor = line.length,
): LineCompletion {
  const before = line.slice(0, cursor);
  const result = tokenizeLine(before);
  const tokens = [...result.tokens];
  let partial = '';
  let replaceStart = cursor;
  // Only the last command of a multi-line input matters.
  let from = 0;
  tokens.forEach((t, i) => {
    if (t.lineStart) from = i;
  });
  const last = tokens[tokens.length - 1];
  if (last && (result.unterminated || last.end === before.length)) {
    tokens.pop();
    partial = last.text;
    replaceStart = last.start;
  } else if (before.slice(last?.end ?? 0).includes('\n')) {
    from = tokens.length;
  }
  const words = tokens.slice(from).map((t) => t.text);
  return { ...suggestNext(catalog, words, partial), replaceStart, replaceEnd: cursor };
}
