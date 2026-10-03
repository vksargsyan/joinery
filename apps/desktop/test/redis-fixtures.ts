import {
  array,
  buildCommandCatalog,
  bulk,
  integer,
  type CommandCatalog,
  type RedisReply,
} from '@querybara/redis-tools';

/**
 * A small command catalog built the way the driver builds it (COMMAND DOCS + COMMAND INFO
 * replies through `buildCommandCatalog`): SET with its argument tree, GET, CONFIG GET / SET,
 * FLUSHALL, EVAL, PUBLISH and SUBSCRIBE.
 */

function record(fields: Record<string, RedisReply>): RedisReply {
  return array(Object.entries(fields).flatMap(([k, v]) => [bulk(k), v]));
}

function words(...values: string[]): RedisReply {
  return array(values.map((v) => bulk(v)));
}

function arg(
  name: string,
  type: string,
  extra: { token?: string; flags?: string[]; arguments?: RedisReply[] } = {},
): RedisReply {
  return record({
    name: bulk(name),
    type: bulk(type),
    ...(extra.token ? { token: bulk(extra.token) } : {}),
    ...(extra.flags ? { flags: words(...extra.flags) } : {}),
    ...(extra.arguments ? { arguments: array(extra.arguments) } : {}),
  });
}

function doc(summary: string, args: RedisReply[], subcommands?: RedisReply): RedisReply {
  return record({
    summary: bulk(summary),
    since: bulk('1.0.0'),
    group: bulk('generic'),
    complexity: bulk('O(1)'),
    arguments: array(args),
    ...(subcommands ? { subcommands } : {}),
  });
}

function info(
  name: string,
  arity: number,
  flags: string[],
  keys: [number, number, number],
  categories: string[],
  subcommands: RedisReply[] = [],
): RedisReply {
  return array([
    bulk(name),
    integer(arity),
    words(...flags),
    integer(keys[0]),
    integer(keys[1]),
    integer(keys[2]),
    words(...categories.map((c) => `@${c}`)),
    array([]),
    array([]),
    array(subcommands),
  ]);
}

const docs = record({
  set: doc('Sets the string value of a key.', [
    arg('key', 'key'),
    arg('value', 'string'),
    arg('condition', 'oneof', {
      flags: ['optional'],
      arguments: [
        arg('nx', 'pure-token', { token: 'NX' }),
        arg('xx', 'pure-token', { token: 'XX' }),
      ],
    }),
    arg('expiration', 'oneof', {
      flags: ['optional'],
      arguments: [
        arg('seconds', 'integer', { token: 'EX' }),
        arg('milliseconds', 'integer', { token: 'PX' }),
        arg('keepttl', 'pure-token', { token: 'KEEPTTL' }),
      ],
    }),
  ]),
  get: doc('Returns the string value of a key.', [arg('key', 'key')]),
  config: doc(
    'A container for server configuration commands.',
    [],
    record({
      'config|get': doc('Returns the effective values of configuration parameters.', [
        arg('parameter', 'string', { flags: ['multiple'] }),
      ]),
      'config|set': doc('Sets configuration parameters in-flight.', [
        arg('data', 'block', {
          flags: ['multiple'],
          arguments: [arg('parameter', 'string'), arg('value', 'string')],
        }),
      ]),
    }),
  ),
  flushall: doc('Removes all keys from all databases.', [
    arg('flush-type', 'oneof', {
      flags: ['optional'],
      arguments: [
        arg('async', 'pure-token', { token: 'ASYNC' }),
        arg('sync', 'pure-token', { token: 'SYNC' }),
      ],
    }),
  ]),
  eval: doc('Executes a server-side Lua script.', [
    arg('script', 'string'),
    arg('numkeys', 'integer'),
    arg('key', 'key', { flags: ['optional', 'multiple'] }),
    arg('arg', 'string', { flags: ['optional', 'multiple'] }),
  ]),
  publish: doc('Posts a message to a channel.', [
    arg('channel', 'string'),
    arg('message', 'string'),
  ]),
  subscribe: doc('Listens for messages published to channels.', [
    arg('channel', 'string', { flags: ['multiple'] }),
  ]),
});

const infos = array([
  info('set', -3, ['write', 'denyoom'], [1, 1, 1], ['write', 'string', 'slow']),
  info('get', 2, ['readonly', 'fast'], [1, 1, 1], ['read', 'string', 'fast']),
  info(
    'config',
    -2,
    [],
    [0, 0, 0],
    ['slow'],
    [
      info(
        'config|get',
        -3,
        ['admin', 'noscript', 'loading', 'stale'],
        [0, 0, 0],
        ['admin', 'slow', 'dangerous'],
      ),
      info(
        'config|set',
        -4,
        ['admin', 'noscript', 'loading', 'stale'],
        [0, 0, 0],
        ['admin', 'slow', 'dangerous'],
      ),
    ],
  ),
  info('flushall', -1, ['write'], [0, 0, 0], ['keyspace', 'write', 'slow', 'dangerous']),
  info(
    'eval',
    -3,
    ['noscript', 'stale', 'skip_monitor', 'may_replicate', 'no_mandatory_keys'],
    [0, 0, 0],
    ['slow', 'scripting'],
  ),
  info(
    'publish',
    3,
    ['pubsub', 'loading', 'stale', 'fast', 'may_replicate'],
    [0, 0, 0],
    ['pubsub', 'fast'],
  ),
  info('subscribe', -2, ['pubsub', 'noscript', 'loading', 'stale'], [0, 0, 0], ['pubsub', 'slow']),
]);

export const CATALOG: CommandCatalog = buildCommandCatalog({ docs, info: infos });
