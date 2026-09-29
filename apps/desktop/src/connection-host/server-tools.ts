import {
  JoineryError,
  isSqlEngine,
  type ConnectionProfile,
  type ServerTools,
  type Session,
} from '@joinery/core';
import type { HandlersOf, serverToolsHostContractShape } from '@joinery/ipc';

import { checkServerAction } from '../shared/server-tools-safety';

/**
 * The connection host's `serverTools.*` handlers (spec §15): each call finds its session and
 * the engine's server tools (MySQL and MariaDB, PostgreSQL, MongoDB; loaded with that engine's
 * driver, which the host has already loaded) and calls them. `run` checks the profile's write
 * rules first (shared/server-tools-safety), whatever the page sends.
 */

type ServerToolsHandlers = HandlersOf<typeof serverToolsHostContractShape>;

export interface ServerToolsHostDeps {
  /** The session a call names; throws NOT_FOUND when it was closed. */
  readonly session: (sessionId: string) => Session;
  /** The connection's profile: its presentation holds the write rules. */
  readonly profile: ConnectionProfile;
}

/** Each session's tools, which cache what they learn about the server (version, privileges). */
const cache = new WeakMap<Session, ServerTools>();

/** The server tools of a session, or NOT_SUPPORTED for engines without them (Redis has its own). */
export async function serverToolsFor(session: Session): Promise<ServerTools> {
  const known = cache.get(session);
  if (known) return known;
  let tools: ServerTools;
  if (session.engine === 'postgres') {
    tools = (await import('@joinery/driver-postgres')).createPostgresServerTools(session);
  } else if (isSqlEngine(session.engine)) {
    tools = (await import('@joinery/driver-mysql')).createMysqlServerTools(session);
  } else if (session.engine === 'mongodb') {
    tools = (await import('@joinery/driver-mongodb')).createMongoServerTools(session);
  } else {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message:
        session.engine === 'redis'
          ? 'Redis has its own server tools (INFO dashboard, slow log, clients, latency, ACL)'
          : 'Server tools are not available for this engine yet',
    });
  }
  cache.set(session, tools);
  return tools;
}

export function serverToolsHandlers(deps: ServerToolsHostDeps): ServerToolsHandlers {
  const tools = (sessionId: string): Promise<ServerTools> =>
    serverToolsFor(deps.session(sessionId));
  return {
    info: async ({ sessionId }) => (await tools(sessionId)).info(),
    monitor: async ({ sessionId }) => (await tools(sessionId)).monitor(),
    sessions: async ({ sessionId, options }) => (await tools(sessionId)).sessions(options),
    topQueries: async ({ sessionId, options }) => (await tools(sessionId)).topQueries(options),
    accounts: async ({ sessionId }) => (await tools(sessionId)).accounts(),
    grants: async ({ sessionId, grantee, scope }) =>
      (await tools(sessionId)).grants(grantee, scope),
    accessDetails: async ({ sessionId, schema }) => (await tools(sessionId)).accessDetails(schema),
    maintenanceTargets: async ({ sessionId, container }) =>
      (await tools(sessionId)).maintenanceTargets(container),
    settings: async ({ sessionId }) => (await tools(sessionId)).settings(),
    preview: async ({ sessionId, action }) => (await tools(sessionId)).preview(action),
    run: async ({ sessionId, action, confirmed }, { signal }) => {
      const server = await tools(sessionId);
      checkServerAction(deps.profile, action, confirmed);
      return server.run(action, { signal });
    },
  };
}
