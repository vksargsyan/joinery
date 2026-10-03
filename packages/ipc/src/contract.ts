import { QuerybaraError } from '@querybara/core';
import { z } from 'zod';

/**
 * RPC contracts. A contract is a tree of methods; each method names the zod schemas for what
 * crosses the port, and both ends validate against the same schemas (spec §3, §18).
 *
 * Types follow zod's input/output split: callers pass `z.input` of the input schema and get
 * `z.output` of the output schema; handlers receive `z.output` of the input and return `z.input`
 * of the output. The sending side sends the *parsed* value, so unknown keys are stripped before
 * anything leaves the process, and the receiving side parses it again. Schemas therefore must
 * accept their own output: defaults, refinements and strict shapes are fine, type-changing
 * transforms (string → Date) are not. They must also be synchronous.
 */

/** A request/response method. `progress`, when present, types the events the handler may emit. */
export interface UnaryMethodDef {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly progress?: z.ZodType;
  readonly item?: never;
}

/** A streaming method: the handler yields items, which the caller reads as an async iterable. */
export interface StreamMethodDef {
  readonly input: z.ZodType;
  readonly item: z.ZodType;
  readonly progress?: z.ZodType;
  readonly output?: never;
}

export type MethodDef = UnaryMethodDef | StreamMethodDef;

/** Methods and nested namespaces; a namespace's key becomes a path segment ("profiles.list"). */
export interface ContractShape {
  readonly [name: string]: MethodDef | ContractShape;
}

/** One method, flattened. `result` is the output schema (unary) or the item schema (stream). */
export interface MethodEntry {
  readonly path: string;
  readonly kind: 'unary' | 'stream';
  readonly input: z.ZodType;
  readonly result: z.ZodType;
  readonly progress: z.ZodType | undefined;
}

export interface Contract<C extends ContractShape = ContractShape> {
  readonly shape: C;
  /** Every method keyed by its dotted path. */
  readonly methods: ReadonlyMap<string, MethodEntry>;
}

/**
 * Names the client object uses for itself or that would make it thenable, and the method-def
 * keys, which would make a namespace look like a method.
 */
const RESERVED_NAMES = new Set(['then', 'dispose', 'input', 'output', 'item', 'progress']);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function collect(shape: unknown, prefix: string, into: Map<string, MethodEntry>): void {
  if (!isPlainObject(shape)) {
    throw new TypeError(`Contract namespace "${prefix}" must be an object`);
  }
  for (const [name, def] of Object.entries(shape)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (!NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw new TypeError(`Invalid contract method name "${path}"`);
    }
    if (!isPlainObject(def)) throw new TypeError(`Contract entry "${path}" must be an object`);
    const hasOutput = def.output !== undefined;
    const hasItem = def.item !== undefined;
    if (!hasOutput && !hasItem) {
      collect(def, path, into);
      continue;
    }
    const { input, output, item, progress } = def;
    if (hasOutput && hasItem) {
      throw new TypeError(`Contract method "${path}" has both an output and an item schema`);
    }
    const result = hasOutput ? output : item;
    if (!isSchema(input) || !isSchema(result) || (progress !== undefined && !isSchema(progress))) {
      throw new TypeError(`Contract method "${path}" must use zod schemas`);
    }
    into.set(path, { path, kind: hasOutput ? 'unary' : 'stream', input, result, progress });
  }
}

/**
 * Declares a contract. Unary methods have `input` and `output`, streams have `input` and `item`;
 * either may add `progress`. Use `z.void()` as the input of a method that takes none.
 *
 * ```ts
 * const contract = defineContract({
 *   ping: { input: z.void(), output: z.void() },
 *   rows: { input: z.object({ n: z.number() }), item: z.number() },
 *   profiles: { list: { input: z.void(), output: z.array(profileSchema) } },
 * });
 * ```
 */
export function defineContract<C extends ContractShape>(shape: C): Contract<C> {
  const methods = new Map<string, MethodEntry>();
  collect(shape, '', methods);
  return { shape, methods };
}

// ---------------------------------------------------------------------------------------------
// Type-level views of a contract.

type ProgressOutput<M> = M extends { readonly progress: infer P extends z.ZodType }
  ? z.output<P>
  : never;
type ProgressInput<M> = M extends { readonly progress: infer P extends z.ZodType }
  ? z.input<P>
  : never;

/** Call options. `onProgress` exists only on methods that declare a progress schema. */
export type CallOptions<P = never> = [P] extends [never]
  ? { readonly signal?: AbortSignal }
  : { readonly signal?: AbortSignal; readonly onProgress?: (progress: P) => void };

type CallArgs<I, O> = undefined extends I ? [input?: I, options?: O] : [input: I, options?: O];

/**
 * A running stream call. It starts when the method is called, so the server prefetches up to the
 * stream window while the caller gets ready. Always consume it, `break` out of it or call
 * `return()`: an abandoned stream keeps its server-side cursor open.
 */
export interface RpcStream<T> extends AsyncIterable<T, undefined> {
  next(): Promise<IteratorResult<T, undefined>>;
  /** Stops the stream and cancels the server side (its handler's iterator is closed). */
  return(): Promise<IteratorResult<T, undefined>>;
  [Symbol.asyncIterator](): RpcStream<T>;
}

export type UnaryCall<M extends UnaryMethodDef> = (
  ...args: CallArgs<z.input<M['input']>, CallOptions<ProgressOutput<M>>>
) => Promise<z.output<M['output']>>;

export type StreamCall<M extends StreamMethodDef> = (
  ...args: CallArgs<z.input<M['input']>, CallOptions<ProgressOutput<M>>>
) => RpcStream<z.output<M['item']>>;

/**
 * The shape behind a contract. The type helpers below accept either `typeof contract` or a bare
 * shape, so `HandlersOf<typeof mainContract>` reads naturally.
 */
export type ShapeOf<T> = T extends Contract<infer C> ? C : T;

type ClientTree<C> = {
  readonly [K in keyof C]: C[K] extends UnaryMethodDef
    ? UnaryCall<C[K]>
    : C[K] extends StreamMethodDef
      ? StreamCall<C[K]>
      : ClientTree<C[K]>;
};

/** The client-side view of a contract: one function per method, nested like the contract. */
export type ClientOf<T> = ClientTree<ShapeOf<T>>;

export interface HandlerContext<P = never> {
  /** Aborts when the caller cancels, the port closes or the server is disposed. */
  readonly signal: AbortSignal;
  /** Sends a progress event, validated against the progress schema. No-op after the call. */
  progress(value: P): void;
}

export type UnaryHandler<M extends UnaryMethodDef> = (
  input: z.output<M['input']>,
  context: HandlerContext<ProgressInput<M>>,
) => z.input<M['output']> | Promise<z.input<M['output']>>;

/**
 * A stream handler returns an async iterable (typically an async generator). The server pulls
 * from it only while the caller has credit, and calls its iterator's `return()` when the caller
 * stops early, so a `finally` block (closing a cursor) always runs.
 */
export type StreamHandler<M extends StreamMethodDef> = (
  input: z.output<M['input']>,
  context: HandlerContext<ProgressInput<M>>,
) => AsyncIterable<z.input<M['item']>>;

type HandlerTree<C> = {
  readonly [K in keyof C]: C[K] extends UnaryMethodDef
    ? UnaryHandler<C[K]>
    : C[K] extends StreamMethodDef
      ? StreamHandler<C[K]>
      : HandlerTree<C[K]>;
};

/** The server-side view of a contract: one handler per method, nested like the contract. */
export type HandlersOf<T> = HandlerTree<ShapeOf<T>>;

type Paths<C, Prefix extends string> = string extends keyof C
  ? string
  : {
      [K in keyof C & string]: C[K] extends MethodDef
        ? `${Prefix}${K}`
        : Paths<C[K], `${Prefix}${K}.`>;
    }[keyof C & string];

/** Dotted paths of every method in a contract, e.g. "profiles.list" | "openConnection". */
export type MethodPath<T> = Paths<ShapeOf<T>, ''>;

type At<C, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof C
    ? At<C[Head], Rest>
    : never
  : P extends keyof C
    ? C[P]
    : never;

/** The method definition at a dotted path. */
export type MethodAt<T, P extends string> = At<ShapeOf<T>, P>;

/** A validated request for one method, as `parseRequest` returns it. */
export type RequestOf<T, P extends MethodPath<T> = MethodPath<T>> = {
  [K in P]: MethodAt<T, K> extends MethodDef
    ? { readonly method: K; readonly input: z.output<MethodAt<T, K>['input']> }
    : never;
}[P];

// ---------------------------------------------------------------------------------------------
// Validation.

export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: QuerybaraError };

/**
 * Validates `value` and returns the parsed result, or a VALIDATION_FAILED error naming `what`.
 * Zod messages never echo the offending value, so the error is safe to send across (it cannot
 * leak a secret that was put in the wrong field).
 */
export function check(schema: z.ZodType, value: unknown, what: string): Checked<unknown> {
  let result: z.ZodSafeParseResult<unknown>;
  try {
    result = schema.safeParse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new QuerybaraError({
        code: 'INTERNAL',
        message: `Cannot validate ${what}: ${message}`,
      }),
    };
  }
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.map(String).join('.')}` : '';
  return {
    ok: false,
    error: new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Invalid ${what}${where}: ${first?.message ?? 'validation failed'}`,
      detail: z.prettifyError(result.error),
    }),
  };
}

/**
 * Validates a raw request for one method of a contract, for transports that do not go through
 * `serve` — e.g. an `ipcMain.handle` channel behind the preload bridge. Returns the method path
 * and the parsed input, narrowed by `method` when it is a literal path.
 *
 * Throws a QuerybaraError: NOT_FOUND for an unknown method, VALIDATION_FAILED for a bad payload.
 */
export function parseRequest<C extends ContractShape, M extends string>(
  contract: Contract<C>,
  method: M,
  payload: unknown,
): M extends MethodPath<C> ? RequestOf<C, M> : RequestOf<C>;
export function parseRequest(
  contract: Contract,
  method: unknown,
  payload: unknown,
): { readonly method: string; readonly input: unknown };
export function parseRequest(
  contract: Contract,
  method: unknown,
  payload: unknown,
): { readonly method: string; readonly input: unknown } {
  const entry = typeof method === 'string' ? contract.methods.get(method) : undefined;
  if (entry === undefined) {
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: `Unknown method ${typeof method === 'string' ? `"${method}"` : ''}`.trimEnd(),
    });
  }
  const checked = check(entry.input, payload, `input for ${entry.path}`);
  if (!checked.ok) throw checked.error;
  return { method: entry.path, input: checked.value };
}
