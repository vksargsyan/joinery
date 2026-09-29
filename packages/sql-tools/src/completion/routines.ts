import type { SqlDialect } from '@joinery/core';

import { significantTokens } from '../lexer';
import type { CatalogRoutine } from './catalog';
import { makeSignature, type FunctionSignature } from './functions';

/**
 * Signatures of user routines from the catalog. Parameter names come from the CREATE statement
 * when it can be read (`f(a integer, b text DEFAULT 'x')`), else from the snapshot's identity
 * signature (PostgreSQL types only). Parameters with a DEFAULT are optional.
 */

const cache = new WeakMap<CatalogRoutine, FunctionSignature>();

/** Only the head of a definition is scanned: parameter lists are short, bodies can be huge. */
const HEAD = 8_000;

export function routineSignature(routine: CatalogRoutine, dialect: SqlDialect): FunctionSignature {
  const cached = cache.get(routine);
  if (cached) return cached;
  const def = routine.def;
  const params =
    parametersOf(def.definition, dialect) ??
    (def.signature ? def.signature.split(/,\s*/).filter((param) => param.length > 0) : []);
  const labels = params.map((param) => (/\bDEFAULT\b|\s=\s/i.test(param) ? `[${param}]` : param));
  const kind =
    def.kind === 'procedure' ? 'Procedure' : def.kind === 'aggregate' ? 'Aggregate' : 'Function';
  const documentation = def.comment ?? `${kind} ${routine.schema.name}.${def.name}`;
  const signature = makeSignature(def.name, labels, def.returns, documentation);
  cache.set(routine, signature);
  return signature;
}

function parametersOf(definition: string, dialect: SqlDialect): string[] | undefined {
  const head = definition.slice(0, HEAD);
  const tokens = significantTokens(head, dialect, { delimiter: '' });
  let k = tokens.findIndex((token) => {
    const upper = token.kind === 'word' ? token.text.toUpperCase() : '';
    return upper === 'FUNCTION' || upper === 'PROCEDURE' || upper === 'AGGREGATE';
  });
  if (k < 0) return undefined;
  k++;
  // The (possibly qualified) name.
  while (k < tokens.length && tokens[k]!.text !== '(') {
    const token = tokens[k]!;
    if (token.kind !== 'word' && token.kind !== 'quoted-identifier' && token.text !== '.') {
      return undefined;
    }
    k++;
  }
  if (tokens[k]?.text !== '(') return undefined;
  const params: string[] = [];
  let depth = 0;
  let start = tokens[k]!.end;
  for (let i = k + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punctuation') continue;
    if (token.text === '(') depth++;
    else if (token.text === ')' && depth > 0) depth--;
    else if ((token.text === ',' && depth === 0) || token.text === ')') {
      const param = head.slice(start, token.start).trim().replace(/\s+/g, ' ');
      if (param.length > 0) params.push(param);
      if (token.text === ')') return params;
      start = token.end;
    }
  }
  return undefined;
}
