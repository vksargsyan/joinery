import {
  compactJson,
  formatJson,
  indexNameProblem,
  mappingRoot,
  nodeText,
  parseJsonTree,
} from '@joinery/search-tools';

import { decideSearchWrite, searchWritePolicy } from '../../../../shared/search-writes';
import { errorMessage } from '../../lib/errors';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';

/**
 * Creating an index (spec §11): a name checked against the server's rules, primary shards and
 * replicas, the mapping and any further settings as JSON, and aliases. The dialog shows the
 * exact request before it runs; the write rules apply as everywhere else.
 */

export interface CreateIndexForm {
  readonly name: string;
  readonly shards: string;
  readonly replicas: string;
  /** The mapping: `{"properties": {...}}` (JSON text); empty for dynamic mapping. */
  readonly mappings: string;
  /** Further settings (JSON text), merged under the shard counts. */
  readonly settings: string;
  /** Comma-separated alias names. */
  readonly aliases: string;
}

export const EMPTY_CREATE_INDEX: CreateIndexForm = {
  name: '',
  shards: '1',
  replicas: '1',
  mappings: '{\n  "properties": {\n    \n  }\n}',
  settings: '{}',
  aliases: '',
};

export type CreateIndexIssues = Partial<Record<keyof CreateIndexForm, string>>;

function count(text: string, what: string, min: number): string | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= min
    ? undefined
    : `${what} is a whole number of at least ${min}`;
}

/** What is wrong with the form, field by field. */
export function createIndexIssues(form: CreateIndexForm): CreateIndexIssues {
  const issues: CreateIndexIssues = {};
  const name = indexNameProblem(form.name.trim());
  if (name) issues.name = name;
  const shards = count(form.shards, 'The number of shards', 1);
  if (shards) issues.shards = shards;
  const replicas = count(form.replicas, 'The number of replicas', 0);
  if (replicas) issues.replicas = replicas;
  if (form.mappings.trim() !== '') {
    try {
      if (mappingRoot(form.mappings) === undefined)
        issues.mappings = 'Write a mapping: {"properties": {...}}';
    } catch (error) {
      issues.mappings = errorMessage(error);
    }
  }
  if (form.settings.trim() !== '') {
    try {
      if (parseJsonTree(form.settings).type !== 'object')
        issues.settings = 'Settings are a JSON object';
    } catch (error) {
      issues.settings = errorMessage(error);
    }
  }
  const badAlias = form.aliases
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
    .map(indexNameProblem)
    .find((p) => p !== undefined);
  if (badAlias) issues.aliases = badAlias.replace(/index/gi, 'alias');
  return issues;
}

/** The body of `PUT /<name>` (JSON text); call after createIndexIssues found nothing. */
export function createIndexBody(form: CreateIndexForm): string {
  const settings: string[] = [];
  if (form.shards.trim() !== '') settings.push(`"index.number_of_shards": ${Number(form.shards)}`);
  if (form.replicas.trim() !== '')
    settings.push(`"index.number_of_replicas": ${Number(form.replicas)}`);
  const extra = form.settings.trim() === '' ? '{}' : compactJson(form.settings);
  if (extra !== '{}') settings.push(extra.slice(1, -1));
  const members = [`"settings": {${settings.join(', ')}}`];
  if (form.mappings.trim() !== '') {
    const root = mappingRoot(form.mappings);
    if (root) members.push(`"mappings": ${compactJson(nodeText(form.mappings, root))}`);
  }
  const aliases = form.aliases
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
  if (aliases.length > 0) {
    members.push(`"aliases": {${aliases.map((a) => `${JSON.stringify(a)}: {}`).join(', ')}}`);
  }
  return `{${members.join(', ')}}`;
}

/** One session per connection for creating indices from the explorer, opened on first use. */
const lanes = new Map<string, SessionLane>();

/**
 * Creates the index after showing its request (and asking where the write rules say so), then
 * reloads the explorer's Indices folder. Resolves with an error message, or undefined when it
 * was created; `null` when the user declined.
 */
export async function createSearchIndex(
  profileId: string,
  form: CreateIndexForm,
): Promise<string | undefined | null> {
  const profile = await profileById(profileId);
  const name = form.name.trim();
  const body = createIndexBody(form);
  if (profile) {
    const decision = decideSearchWrite({ writes: true }, searchWritePolicy(profile));
    if (decision.action === 'refuse') return decision.reason;
    if (decision.action === 'confirm') {
      const ok = await confirm({
        title: `Create the index ${name}?`,
        message: decision.reason,
        detail: `PUT /${name}\n${formatJson(body)}`,
        confirmLabel: 'Create',
        danger: false,
      });
      if (!ok) return null;
    }
  }
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  try {
    await lane.run((host, sessionId) =>
      host.search.indices.create({ sessionId, name, body, confirmed: true }),
    );
  } catch (error) {
    return errorMessage(error);
  }
  await loadChildren(profileId, ['indices']);
  return undefined;
}
