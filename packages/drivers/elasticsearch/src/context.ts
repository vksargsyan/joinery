import { QuerybaraError, newId } from '@querybara/core';
import { parseJsonTree, type JsonNode, type SearchCapabilities } from '@querybara/search-tools';

import type { SearchClientPlan } from './config';
import { mapResponseError, mapTransportError, type SearchErrorContext } from './errors';
import type { HttpRequest, HttpResponse, SearchHttpClient } from './http';
import type { SearchOpOptions } from './types';

/** What the service modules know about the server they talk to. */
export interface ServerFacts {
  readonly version: string;
  readonly buildFlavor?: string;
  readonly capabilities: SearchCapabilities;
}

/** One call registered for `cancel`: its abort controller and the X-Opaque-Id it sent. */
interface Execution {
  readonly controller: AbortController;
  readonly opaqueId: string;
  cancelled: boolean;
}

/** A request for a service: an HttpRequest whose signal and timeout come from the options. */
export type ServiceRequest = Omit<HttpRequest, 'signal' | 'timeoutMs' | 'opaqueId'>;

/**
 * The shared state behind a session and its service modules: the HTTP client, the plan, the
 * server facts, and the calls in flight (so `cancel` can abort them and cancel their tasks).
 */
export class SearchContext {
  readonly executions = new Map<string, Execution>();
  closed = false;

  constructor(
    readonly http: SearchHttpClient,
    readonly plan: SearchClientPlan,
    public facts: ServerFacts,
  ) {}

  errorContext(extra: Partial<SearchErrorContext> = {}): SearchErrorContext {
    return {
      where: this.plan.where,
      secrets: this.plan.secrets,
      authMethod: this.plan.authMethod,
      ...(this.plan.user !== undefined ? { user: this.plan.user } : {}),
      ...extra,
    };
  }

  assertOpen(): void {
    if (this.closed) {
      throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    }
  }

  /**
   * Sends a request with the call's signal, timeout and execution id; transport failures are
   * mapped to QuerybaraErrors. The response is returned whatever its status.
   */
  async send(request: ServiceRequest, opts: SearchOpOptions = {}): Promise<HttpResponse> {
    this.assertOpen();
    const executionId = opts.executionId;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const execution: Execution = {
      controller,
      opaqueId: `querybara-${executionId ?? newId()}`,
      cancelled: false,
    };
    if (executionId !== undefined) this.executions.set(executionId, execution);
    try {
      return await this.http.request({
        ...request,
        signal: controller.signal,
        opaqueId: execution.opaqueId,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } catch (error) {
      throw mapTransportError(
        error,
        this.errorContext({ cancelRequested: execution.cancelled || controller.signal.aborted }),
      );
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (executionId !== undefined && this.executions.get(executionId) === execution) {
        this.executions.delete(executionId);
      }
    }
  }

  /** Sends a request and throws the mapped error unless it succeeded (2xx). */
  async call(request: ServiceRequest, opts: SearchOpOptions = {}): Promise<HttpResponse> {
    const response = await this.send(request, opts);
    if (response.status >= 200 && response.status < 300) return response;
    throw mapResponseError(
      response.status,
      response.body,
      this.errorContext(request.body !== undefined ? { requestBody: request.body } : {}),
    );
  }

  /** `call`, then the body parsed as lossless JSON. */
  async json(
    request: ServiceRequest,
    opts: SearchOpOptions = {},
  ): Promise<{ node: JsonNode; text: string }> {
    const response = await this.call(request, opts);
    try {
      return { node: parseJsonTree(response.body), text: response.body };
    } catch {
      throw new QuerybaraError({
        code: 'INTERNAL',
        message: `${this.plan.where} answered ${request.method} ${request.path} with a body that is not JSON`,
      });
    }
  }

  /**
   * Cancels a call: aborts its HTTP request (the server stops a search whose connection
   * closes) and cancels the server tasks that carry its X-Opaque-Id (update and delete by
   * query, reindex, force merge...), from a separate request.
   */
  async cancel(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) return;
    execution.cancelled = true;
    execution.controller.abort();
    try {
      const response = await this.http.request({
        method: 'GET',
        path: '/_tasks',
        query: 'detailed=true&group_by=none',
        timeoutMs: 10_000,
      });
      if (response.status !== 200) return;
      const root = parseJsonTree(response.body);
      const tasks =
        root.type === 'object' ? root.members.find((m) => m.key === 'tasks')?.value : undefined;
      const ids: string[] = [];
      if (tasks?.type === 'array') {
        for (const task of tasks.items) {
          if (task.type !== 'object') continue;
          const read = (key: string): JsonNode | undefined =>
            task.members.find((m) => m.key === key)?.value;
          const headers = read('headers');
          const opaque =
            headers?.type === 'object'
              ? headers.members.find((m) => m.key.toLowerCase() === 'x-opaque-id')?.value
              : undefined;
          const cancellable = read('cancellable');
          const node = read('node');
          const id = read('id');
          if (
            opaque?.type === 'string' &&
            opaque.value === execution.opaqueId &&
            cancellable?.type === 'boolean' &&
            cancellable.value &&
            node?.type === 'string' &&
            id?.type === 'number'
          ) {
            ids.push(`${node.value}:${id.text}`);
          }
        }
      }
      await Promise.all(
        ids.map((id) =>
          this.http
            .request({ method: 'POST', path: `/_tasks/${id}/_cancel`, timeoutMs: 10_000 })
            .catch(() => undefined),
        ),
      );
    } catch {
      // Best effort: the HTTP request is aborted whatever happens here.
    }
  }
}

/** A query string from parameters, leaving out undefined ones. */
export function queryString(
  params: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** A path segment for a name (index, id, alias...), percent-encoded. */
export function segment(name: string): string {
  if (name === '') {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'A name in the path is empty' });
  }
  return encodeURIComponent(name);
}

/** Comma-separated index names for a path. */
export function indexList(names: readonly string[]): string {
  if (names.length === 0) {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Name at least one index' });
  }
  return names.map(segment).join(',');
}
