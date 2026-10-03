import {
  commandSyntax,
  completeLine,
  formatReply,
  lookupCommand,
  splitArgs,
  splitCommands,
  tokenizeLine,
  type CommandCatalog,
  type CommandDoc,
  type CommandSuggestion,
  type RedisReply,
} from '@querybara/redis-tools';

/**
 * The Redis CLI panel's line model (spec §10): history with ↑/↓ and the unsent draft kept,
 * autocomplete and inline docs from the command catalog (redis-tools `completeLine`), and the
 * output log rendered in redis-cli format or as raw RESP.
 */

// ---------------------------------------------------------------------------------------------
// History

/**
 * Command history, oldest first. ↑ walks back from the line being typed (which is kept as the
 * draft) and ↓ walks forward to it again; a new command goes to the end, and repeating the last
 * one does not add it twice.
 */
export class CliHistory {
  #entries: string[];
  #index: number;
  #draft = '';
  readonly #limit: number;

  constructor(entries: readonly string[] = [], limit = 500) {
    this.#limit = limit;
    this.#entries = entries.slice(-limit);
    this.#index = this.#entries.length;
  }

  get entries(): readonly string[] {
    return this.#entries;
  }

  /** Adds a command run from the panel and returns to the draft position. */
  push(line: string): void {
    const text = line.trim();
    if (text !== '' && this.#entries.at(-1) !== text) {
      this.#entries.push(text);
      if (this.#entries.length > this.#limit) this.#entries.shift();
    }
    this.#index = this.#entries.length;
    this.#draft = '';
  }

  /** The previous command, or undefined at the oldest. `current` is kept as the draft. */
  up(current: string): string | undefined {
    if (this.#index === 0) return undefined;
    if (this.#index === this.#entries.length) this.#draft = current;
    this.#index -= 1;
    return this.#entries[this.#index];
  }

  /** The next command, then the draft; undefined when already at the draft. */
  down(): string | undefined {
    if (this.#index >= this.#entries.length) return undefined;
    this.#index += 1;
    return this.#index === this.#entries.length ? this.#draft : this.#entries[this.#index];
  }
}

// ---------------------------------------------------------------------------------------------
// Autocomplete and inline docs

export interface CliCompletion {
  /** Suggestions to pick from: commands, subcommands, keywords, then argument placeholders. */
  readonly items: readonly CommandSuggestion[];
  /** The part of the line a picked suggestion replaces. */
  readonly replaceStart: number;
  readonly replaceEnd: number;
  /** The command being typed, for the inline docs. */
  readonly command?: CommandDoc;
  /** Its syntax line: `SET key value [NX | XX] ...`. */
  readonly syntax?: string;
  /** Placeholders of the arguments that may come next, for the hint after the cursor. */
  readonly nextArguments: readonly string[];
  /** What the word under the cursor is (its placeholders), while it is being typed. */
  readonly currentArguments: readonly string[];
  /** Nothing more is required: the command can run as typed. */
  readonly complete: boolean;
  readonly unknownCommand: boolean;
}

const MAX_ITEMS = 50;

/** Autocomplete and docs for the line with the cursor at `cursor`. */
export function cliCompletion(
  catalog: CommandCatalog | undefined,
  line: string,
  cursor = line.length,
): CliCompletion {
  if (!catalog) {
    return {
      items: [],
      replaceStart: cursor,
      replaceEnd: cursor,
      nextArguments: [],
      currentArguments: [],
      complete: false,
      unknownCommand: false,
    };
  }
  const result = completeLine(catalog, line, cursor);
  const items = result.suggestions.filter((s) => s.kind !== 'argument').slice(0, MAX_ITEMS);
  const placeholders = (suggestions: readonly CommandSuggestion[]): string[] =>
    suggestions
      .filter((s) => s.kind === 'argument')
      .map((s) => (s.optional ? `[${s.text}]` : s.text));
  const typing =
    result.replaceStart < result.replaceEnd
      ? completeLine(catalog, line, result.replaceStart).suggestions
      : [];
  return {
    items,
    replaceStart: result.replaceStart,
    replaceEnd: result.replaceEnd,
    ...(result.command ? { command: result.command, syntax: commandSyntax(result.command) } : {}),
    nextArguments: placeholders(result.suggestions),
    currentArguments: placeholders(typing),
    complete: result.complete,
    unknownCommand: result.unknownCommand,
  };
}

/** The line after picking a suggestion: the word under the cursor replaced, then a space. */
export function acceptSuggestion(
  line: string,
  completion: Pick<CliCompletion, 'replaceStart' | 'replaceEnd'>,
  suggestion: CommandSuggestion,
): { readonly line: string; readonly cursor: number } {
  const before = line.slice(0, completion.replaceStart);
  const after = line.slice(completion.replaceEnd);
  const inserted = `${suggestion.text} `;
  const rest = after.startsWith(' ') ? after.slice(1) : after;
  return { line: `${before}${inserted}${rest}`, cursor: before.length + inserted.length };
}

/** The command docs for the words of a line (for the docs panel after a command ran). */
export function commandDocFor(
  catalog: CommandCatalog | undefined,
  line: string,
): CommandDoc | undefined {
  if (!catalog) return undefined;
  const words = tokenizeLine(line).tokens.map((t) => t.text);
  return lookupCommand(catalog, words)?.doc;
}

/** Commands whose job a dedicated tool does (the host refuses them in the CLI). */
export function toolForCommand(words: readonly string[]): 'pubsub' | 'monitor' | undefined {
  const name = (words[0] ?? '').toLowerCase();
  if (/^[ps]?subscribe$/.test(name) || /^[ps]?unsubscribe$/.test(name)) return 'pubsub';
  if (name === 'monitor') return 'monitor';
  return undefined;
}

/** The commands of the input: one per line (quoted line breaks belong to the argument). */
export function parseCliInput(text: string): Uint8Array[][] {
  return splitCommands(text).filter((args) => args.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Output

export type CliFormat = 'cli' | 'resp';

export interface CliEntry {
  readonly id: string;
  /** The command as typed (one command of the input). */
  readonly line: string;
  readonly at: number;
  readonly database: number;
  readonly node?: string;
  readonly reply?: RedisReply;
  readonly error?: string;
  readonly hint?: string;
  readonly durationMs?: number;
  /** Still running (can be cancelled). */
  readonly running?: boolean;
  /** Cancelled by the user. */
  readonly cancelled?: boolean;
}

/** A reply in redis-cli's format, or as the RESP bytes on the wire (CRLF shown as `\r\n`). */
export function renderReply(reply: RedisReply, format: CliFormat): string {
  if (format === 'cli') return formatReply(reply, 'cli', { utf8: true });
  return formatReply(reply, 'raw').replace(/\r\n/g, '\\r\\n\n').replace(/\n$/, '');
}

/** The prompt redis-cli shows: `127.0.0.1:6379[3]>` (the database only when not 0). */
export function cliPrompt(address: string, database: number): string {
  return `${address}${database === 0 ? '' : `[${database}]`}>`;
}

/**
 * A list of names typed like redis-cli arguments: separated by spaces, quoted when they hold
 * spaces or escapes. Throws for an unbalanced quote.
 */
export function parseNameList(text: string): Uint8Array[] {
  return text.trim() === '' ? [] : splitArgs(text);
}

/** Appends to a bounded log, dropping the oldest entries. */
export function appendBounded<T>(log: readonly T[], added: readonly T[], max: number): T[] {
  const next = [...log, ...added];
  return next.length > max ? next.slice(next.length - max) : next;
}
