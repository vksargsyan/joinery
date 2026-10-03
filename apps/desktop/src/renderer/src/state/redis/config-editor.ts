import type { ConfigApplyResult, ConfigNode, ConfigTarget } from '@querybara/driver-redis';
import {
  CONFIG_GROUPS,
  configSetCommands,
  filterConfigRows,
  isConfigMutable,
  sameConfigValue,
  validateConfigValue,
  type ConfigChange,
  type ConfigGroupId,
  type ConfigRow,
} from '@querybara/redis-tools';

import { formatCommandLine } from '../../../../shared/redis-safety';

/**
 * The configuration editor (spec §15, "CONFIG GET and SET"): which rows to list, the typed
 * editor each parameter gets, the drafts the user typed turned into validated pending changes,
 * the exact CONFIG SET commands they send (secrets masked), and what an apply did per node.
 */

/** Which rows the list shows. */
export type ConfigFilter = 'all' | 'changed' | 'differs' | 'pending';

export const CONFIG_FILTERS: readonly { readonly id: ConfigFilter; readonly label: string }[] = [
  { id: 'all', label: 'All parameters' },
  { id: 'changed', label: 'Changed from default' },
  { id: 'differs', label: 'Different between nodes' },
  { id: 'pending', label: 'Pending changes' },
];

/** What the user typed, by parameter name (not yet validated or compared). */
export type ConfigDrafts = Readonly<Record<string, string>>;

export interface ConfigGroupView {
  readonly id: ConfigGroupId;
  readonly title: string;
  readonly rows: readonly ConfigRow[];
}

/** The rows the search and filter keep, by group in display order (empty groups dropped). */
export function groupConfigRows(
  rows: readonly ConfigRow[],
  options: {
    readonly search: string;
    readonly filter: ConfigFilter;
    readonly drafts: ConfigDrafts;
  },
): ConfigGroupView[] {
  const kept = filterConfigRows(rows, options.search).filter((row) => {
    switch (options.filter) {
      case 'all':
        return true;
      case 'changed':
        return row.isDefault === false;
      case 'differs':
        return row.differs;
      case 'pending':
        return options.drafts[row.name] !== undefined;
    }
  });
  return CONFIG_GROUPS.map((group) => ({
    ...group,
    rows: kept.filter((row) => row.group === group.id),
  })).filter((group) => group.rows.length > 0);
}

/** The editor a row gets: a select, a text field, a password field, or none (startup only). */
export type ConfigEditorKind = 'readonly' | 'secret' | 'select' | 'text';

export function editorKind(row: ConfigRow, redisVersion: string): ConfigEditorKind {
  if (!isConfigMutable(row.name, redisVersion)) return 'readonly';
  if (row.secret) return 'secret';
  const type = row.meta?.type;
  return type === 'boolean' || type === 'enum' ? 'select' : 'text';
}

/** A select's choices: the known values, plus the current one if the server has another. */
export function selectChoices(row: ConfigRow): string[] {
  const values = [...(row.meta?.values ?? [])];
  for (const node of row.byNode) {
    if (!values.some((v) => sameConfigValue(row.name, v, node.value))) values.push(node.value);
  }
  return values;
}

/** The value an editor shows: the draft, else the common value ("" where the nodes differ). */
export function editorValue(row: ConfigRow, drafts: ConfigDrafts): string {
  return drafts[row.name] ?? (row.secret ? '' : (row.value ?? ''));
}

/**
 * A draft after an edit: removed when it is back to the current value (or an empty secret),
 * kept otherwise, even when invalid (the pending list says why).
 */
export function updateDrafts(drafts: ConfigDrafts, row: ConfigRow, typed: string): ConfigDrafts {
  const { [row.name]: _previous, ...rest } = drafts;
  const unchanged = row.secret || row.value === undefined ? typed === '' : typed === row.value;
  return unchanged ? rest : { ...rest, [row.name]: typed };
}

export interface PendingChange extends ConfigChange {
  readonly secret: boolean;
  /** The value now (the mask for secrets; undefined where the nodes differ). */
  readonly current: string | undefined;
  /** Why it cannot be sent as typed. */
  readonly error?: string;
}

/**
 * The drafts as changes to send, in row order: validated and normalised; drafts that mean the
 * current value ("64mb" for 67108864) are left out.
 */
export function pendingChanges(rows: readonly ConfigRow[], drafts: ConfigDrafts): PendingChange[] {
  const out: PendingChange[] = [];
  for (const row of rows) {
    const draft = drafts[row.name];
    if (draft === undefined) continue;
    const checked = validateConfigValue(row.name, draft);
    if (!checked.ok) {
      out.push({
        name: row.name,
        value: draft,
        secret: row.secret,
        current: row.value,
        error: checked.error,
      });
      continue;
    }
    if (
      !row.secret &&
      row.value !== undefined &&
      sameConfigValue(row.name, checked.value, row.value)
    ) {
      continue;
    }
    out.push({ name: row.name, value: checked.value, secret: row.secret, current: row.value });
  }
  return out;
}

/** The exact commands the changes send, as redis-cli lines, with secret values masked. */
export function previewCommands(changes: readonly ConfigChange[], multiSet: boolean): string[] {
  return configSetCommands(changes, { multi: multiSet, mask: true }).map((args) =>
    formatCommandLine(args, 4096),
  );
}

/** The failures of an apply, and the parameters applied on every node. */
export function applyOutcome(result: ConfigApplyResult): {
  readonly applied: readonly string[];
  readonly failed: readonly {
    readonly name: string;
    readonly node: string;
    readonly error: string;
  }[];
} {
  const failed: { name: string; node: string; error: string }[] = [];
  const names = new Set<string>();
  for (const node of result.nodes) {
    for (const p of node.parameters) {
      names.add(p.name);
      if (!p.applied)
        failed.push({ name: p.name, node: node.node, error: p.error ?? 'Not applied' });
    }
  }
  const failedNames = new Set(failed.map((f) => f.name));
  return { applied: [...names].filter((n) => !failedNames.has(n)), failed };
}

/** Drafts left after an apply: the ones that failed somewhere stay pending. */
export function draftsAfterApply(drafts: ConfigDrafts, result: ConfigApplyResult): ConfigDrafts {
  const applied = new Set(applyOutcome(result).applied);
  return Object.fromEntries(Object.entries(drafts).filter(([name]) => !applied.has(name)));
}

// ---------------------------------------------------------------------------------------------
// Targets

export interface ConfigTargetChoice {
  /** The select's value: "" for the default target. */
  readonly value: string;
  readonly label: string;
}

/** Choice value for every Cluster node, replicas included. */
export const ALL_NODES = '*';

/**
 * The target choices: in Cluster mode every primary (the default), every node, then each
 * node; in Sentinel mode the master (the default), then each replica; otherwise the server.
 */
export function targetChoices(
  nodes: readonly ConfigNode[],
  topology: 'standalone' | 'sentinel' | 'cluster',
): ConfigTargetChoice[] {
  const describe = (n: ConfigNode): ConfigTargetChoice => ({
    value: n.address,
    label: `${n.address} (${n.role})`,
  });
  if (topology === 'cluster') {
    const primaries = nodes.filter((n) => n.role === 'primary').length;
    const replicas = nodes.length - primaries;
    return [
      { value: '', label: `All primaries (${primaries})` },
      ...(replicas > 0 ? [{ value: ALL_NODES, label: `All nodes (${nodes.length})` }] : []),
      ...nodes.map(describe),
    ];
  }
  const [main, ...others] = nodes;
  return [
    {
      value: '',
      label: main
        ? `${main.address} (${topology === 'sentinel' ? 'master' : main.role})`
        : 'Server',
    },
    ...others.map(describe),
  ];
}

/** The configuration target of a choice. */
export function targetOf(choice: string): ConfigTarget {
  if (choice === '') return {};
  if (choice === ALL_NODES) return { replicas: true };
  return { node: choice };
}
