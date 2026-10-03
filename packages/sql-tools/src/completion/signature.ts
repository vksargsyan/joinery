import type { SqlDialect } from '@querybara/core';

import { locate, StatementModel } from './analysis';
import type { Catalog } from './catalog';
import { isCallGroup } from './classify';
import { builtinFunctions, type FunctionSignature } from './functions';
import { identOf, type Ident } from './names';
import { routineSignature } from './routines';

/**
 * Signature help (spec §6): inside a function call's parentheses, the function's signatures
 * and the argument the cursor is on. Built-in functions of the dialect and user routines from
 * the catalog (by name through the search path, or schema-qualified).
 */

export interface SignatureHelp {
  /** The function name as written before the parenthesis. */
  readonly name: string;
  /** One per overload; parameter start/end are offsets into each label. */
  readonly signatures: readonly FunctionSignature[];
  readonly activeSignature: number;
  /** Zero-based index of the argument at the cursor. */
  readonly activeParameter: number;
  /** Offset of the call's opening parenthesis. */
  readonly open: number;
}

export function signatureHelp(
  text: string,
  offset: number,
  dialect: SqlDialect,
  catalog: Catalog,
): SignatureHelp | undefined {
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, text.length));
  const located = locate(text, at, dialect, true);
  if (!located) return undefined;
  const model = new StatementModel(located);
  let group = model.groupAt(model.at);
  while (group >= 0 && !isCallGroup(model, group)) group = model.parentOf(group);
  if (group < 0) return undefined;

  const parts: Ident[] = [];
  let k = group - 1;
  for (;;) {
    const tok = model.toks[k];
    const ident = tok ? identOf(tok) : undefined;
    if (!ident) break;
    parts.unshift(ident);
    if (!model.isPunct(k - 1, '.')) break;
    k -= 2;
  }
  const name = parts[parts.length - 1];
  if (!name) return undefined;

  const signatures: FunctionSignature[] = [];
  if (parts.length === 1) {
    const builtin = builtinFunctions(dialect).get(name.name.toLowerCase());
    if (builtin) signatures.push(...builtin.signatures);
  }
  for (const routine of catalog.findRoutines(parts)) {
    signatures.push(routineSignature(routine, dialect));
  }
  if (signatures.length === 0) return undefined;

  const commas = model.membersOf(group).filter((i) => i < model.at && model.isPunct(i, ',')).length;
  let active = signatures.findIndex(
    (signature) => signature.variadic || signature.maxArgs > commas,
  );
  if (active < 0) active = 0;
  const signature = signatures[active]!;
  const last = signature.parameters.length - 1;
  return {
    name: parts.map((part) => part.name).join('.'),
    signatures,
    activeSignature: active,
    activeParameter: last < 0 ? 0 : Math.min(commas, last),
    open: model.toks[group]!.start,
  };
}
