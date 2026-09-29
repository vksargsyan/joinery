import { connectionOptionsSchema } from '@joinery/core';

/**
 * Small readers of connection URI text for the connection dialog. Main owns URI parsing (the
 * profile comes from @joinery/storage's parser over IPC); these only answer what the page needs
 * on its own side: the pasted password, which never travels back from main, and how many hosts a
 * URI names. They read a URI the way that parser does, so both sides agree on where the user info
 * and the hosts are.
 */

/** Read preferences a MongoDB profile can hold, in the driver's spelling. */
export const READ_PREFERENCES = connectionOptionsSchema.shape.readPreference.unwrap().options;
export type ReadPreference = (typeof READ_PREFERENCES)[number];

interface UriSplit {
  /** Lower case, without a `jdbc:` prefix. */
  readonly scheme: string;
  /** The user info before the authority's last `@`, as written; undefined without one. */
  readonly userinfo: string | undefined;
  /** The comma-separated hosts, as written. */
  readonly hosts: readonly string[];
  /** The query string without its `?`; '' when absent. */
  readonly query: string;
}

function splitUri(uri: string): UriSplit | undefined {
  const text = uri.trim().replace(/^jdbc:/i, '');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (!scheme?.[1]) return undefined;
  let rest = text.slice(scheme[0].length);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  let query = '';
  const question = rest.indexOf('?');
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  const authority = rest.slice(0, authorityEnd(rest));
  const at = authority.lastIndexOf('@');
  const hostText = at >= 0 ? authority.slice(at + 1) : authority;
  return {
    scheme: scheme[1].toLowerCase(),
    userinfo: at >= 0 ? authority.slice(0, at) : undefined,
    hosts: hostText === '' ? [] : hostText.split(','),
    query,
  };
}

/** The authority ends at the first '/' outside parentheses (MySQL writes sockets as `(/path)`). */
function authorityEnd(rest: string): number {
  let depth = 0;
  for (let index = 0; index < rest.length; index++) {
    const ch = rest[index];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '/' && depth === 0) return index;
  }
  return rest.length;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The URI's scheme in lower case (`mongodb+srv`, `rediss`...), or undefined for other text. */
export function uriScheme(uri: string): string | undefined {
  return splitUri(uri)?.scheme;
}

/**
 * The hosts a URI names, as written (`a:1`, `[::1]:27017`), with no user info. Several for a
 * multi-host MongoDB or Redis URI; one DNS name for `mongodb+srv://`, which stands for several.
 */
export function uriHosts(uri: string): readonly string[] {
  return splitUri(uri)?.hosts.filter((host) => host !== '') ?? [];
}

/**
 * The password in a pasted URI, which the page still has: main's parser never sends it back
 * (secrets only flow towards main). It is the user info after its first `:`, percent-decoded,
 * even for a multi-host URI or a password with an unencoded `@`; without one, the last
 * `password=` query parameter, as the parser takes it.
 */
export function passwordFromUri(uri: string): string | undefined {
  const parts = splitUri(uri);
  if (!parts) return undefined;
  const colon = parts.userinfo?.indexOf(':') ?? -1;
  const inUserinfo =
    parts.userinfo !== undefined && colon >= 0
      ? safeDecode(parts.userinfo.slice(colon + 1))
      : undefined;
  if (inUserinfo !== undefined && inUserinfo !== '') return inUserinfo;
  let param: string | undefined;
  for (const piece of parts.query.split('&')) {
    const equals = piece.indexOf('=');
    if (equals >= 0 && safeDecode(piece.slice(0, equals)).toLowerCase() === 'password') {
      param = safeDecode(piece.slice(equals + 1));
    }
  }
  return param !== undefined && param !== '' ? param : inUserinfo;
}
