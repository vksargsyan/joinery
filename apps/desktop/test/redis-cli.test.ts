import { array, bulk, errorReply, integer, NIL, status, utf8Bytes } from '@querybara/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  CliHistory,
  acceptSuggestion,
  appendBounded,
  cliCompletion,
  cliPrompt,
  commandDocFor,
  parseCliInput,
  parseNameList,
  renderReply,
  toolForCommand,
} from '../src/renderer/src/state/redis/cli';
import { CATALOG } from './redis-fixtures';

describe('CLI history', () => {
  it('walks back and forth and keeps the unsent line as the draft', () => {
    const history = new CliHistory(['GET a', 'SET a 1']);
    expect(history.up('typing')).toBe('SET a 1');
    expect(history.up('SET a 1')).toBe('GET a');
    expect(history.up('GET a')).toBeUndefined();
    expect(history.down()).toBe('SET a 1');
    expect(history.down()).toBe('typing');
    expect(history.down()).toBeUndefined();
  });

  it('adds new commands at the end without repeating the last one', () => {
    const history = new CliHistory([], 3);
    for (const line of ['PING', 'PING', '  ', 'GET a', 'GET b', 'GET c']) history.push(line);
    expect(history.entries).toEqual(['GET a', 'GET b', 'GET c']);
    expect(history.up('')).toBe('GET c');
    history.push('DBSIZE');
    expect(history.up('')).toBe('DBSIZE');
  });
});

describe('CLI autocomplete and inline docs', () => {
  it('suggests commands for the first word and replaces what was typed', () => {
    const all = cliCompletion(CATALOG, '');
    expect(all.items.map((i) => i.text)).toContain('SET');
    const typed = cliCompletion(CATALOG, 'se');
    expect(typed.items.map((i) => [i.kind, i.text])).toEqual([['command', 'SET']]);
    expect(typed.items[0]!.detail).toBe('Sets the string value of a key.');
    const accepted = acceptSuggestion('se', typed, typed.items[0]!);
    expect(accepted).toEqual({ line: 'SET ', cursor: 4 });
  });

  it('shows the syntax and the argument being typed, then the next ones', () => {
    const start = cliCompletion(CATALOG, 'SET ');
    expect(start.syntax).toBe('SET key value [NX | XX] [EX seconds | PX milliseconds | KEEPTTL]');
    expect(start.nextArguments).toEqual(['key']);
    expect(start.items).toEqual([]);
    const typing = cliCompletion(CATALOG, 'SET us');
    expect(typing.currentArguments).toEqual(['key']);
    const options = cliCompletion(CATALOG, 'SET k v ');
    expect(options.items.map((i) => i.text)).toEqual(['NX', 'XX', 'EX', 'PX', 'KEEPTTL']);
    expect(options.complete).toBe(true);
    const after = cliCompletion(CATALOG, 'SET k v EX ');
    expect(after.nextArguments).toEqual(['[seconds]']);
    expect(after.complete).toBe(false);
  });

  it('completes keywords case-insensitively in the middle of a line', () => {
    const line = 'set k v e more';
    const completion = cliCompletion(CATALOG, line, 9);
    expect(completion.items.map((i) => i.text)).toEqual(['EX']);
    expect(acceptSuggestion(line, completion, completion.items[0]!)).toEqual({
      line: 'set k v EX more',
      cursor: 11,
    });
  });

  it('suggests subcommands of a container command', () => {
    const completion = cliCompletion(CATALOG, 'config ');
    expect(completion.items.map((i) => i.text)).toEqual(['GET', 'SET']);
    expect(cliCompletion(CATALOG, 'config get ').syntax).toBe(
      'CONFIG GET parameter [parameter ...]',
    );
    expect(commandDocFor(CATALOG, 'CONFIG SET maxmemory 1mb')?.name).toBe('CONFIG SET');
  });

  it('flags unknown commands and works without a catalog', () => {
    expect(cliCompletion(CATALOG, 'NOPE x').unknownCommand).toBe(true);
    expect(cliCompletion(undefined, 'SET ')).toMatchObject({ items: [], nextArguments: [] });
  });
});

describe('CLI input and output', () => {
  it('splits the input into commands like redis-cli', () => {
    const commands = parseCliInput('SET "a b" "x\\xff"\n\nGET \'a b\'');
    expect(commands).toHaveLength(2);
    expect(commands[0]!.map((a) => [...a])).toEqual([
      [...utf8Bytes('SET')],
      [...utf8Bytes('a b')],
      [0x78, 0xff],
    ]);
    expect(() => parseCliInput('SET "unterminated')).toThrow(/Invalid argument/);
  });

  it('points hijacking commands to their tool', () => {
    expect(toolForCommand(['PSUBSCRIBE', 'news.*'])).toBe('pubsub');
    expect(toolForCommand(['sunsubscribe'])).toBe('pubsub');
    expect(toolForCommand(['MONITOR'])).toBe('monitor');
    expect(toolForCommand(['GET', 'k'])).toBeUndefined();
  });

  it('renders replies as redis-cli does, or as raw RESP', () => {
    const reply = array([bulk('a'), integer(2), NIL, array([status('OK')])]);
    expect(renderReply(reply, 'cli')).toBe(
      ['1) "a"', '2) (integer) 2', '3) (nil)', '4) 1) OK'].join('\n'),
    );
    expect(renderReply(reply, 'resp')).toBe(
      ['*4\\r\\n', '$1\\r\\n', 'a\\r\\n', ':2\\r\\n', '$-1\\r\\n', '*1\\r\\n', '+OK\\r\\n'].join(
        '\n',
      ),
    );
    expect(renderReply(errorReply('ERR wrong'), 'cli')).toBe('(error) ERR wrong');
    expect(renderReply(bulk('café'), 'cli')).toBe('"café"');
  });

  it('builds the prompt and parses name lists', () => {
    expect(cliPrompt('127.0.0.1:6379', 0)).toBe('127.0.0.1:6379>');
    expect(cliPrompt('127.0.0.1:6379', 3)).toBe('127.0.0.1:6379[3]>');
    expect(parseNameList('news "two words"').map((b) => new TextDecoder().decode(b))).toEqual([
      'news',
      'two words',
    ]);
    expect(parseNameList('  ')).toEqual([]);
    expect(appendBounded([1, 2], [3, 4], 3)).toEqual([2, 3, 4]);
  });
});
