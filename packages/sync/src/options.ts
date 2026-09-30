/**
 * Structure compare options (spec §13, "Options"). Every flag defaults to the value that keeps
 * the round-trip invariant (deploy, re-compare, zero differences) true for a typical pair of
 * environments.
 */

/** Object kinds a user rename rule can map. */
export type RenameObjectKind = 'table' | 'column' | 'index' | 'constraint' | 'view';

/**
 * A user mapping that turns a drop + create into a rename (spec §13, step 3). `from` is the name
 * in the target, `to` the name in the source (the name the target should end up with).
 * `schema` narrows PostgreSQL rules; `table` locates columns, indexes and constraints and may
 * be given as either the source or the target table name.
 */
export interface RenameRule {
  readonly objectKind: RenameObjectKind;
  readonly schema?: string;
  readonly table?: string;
  readonly from: string;
  readonly to: string;
}

/** What the comparison ignores and how it matches names. */
export interface CompareOptions {
  /** Ignore table, column, view, routine, type, schema and index comments. */
  readonly ignoreComments?: boolean;
  /** Ignore collations (character sets are still compared: changing them can lose data). */
  readonly ignoreCollation?: boolean;
  /** Ignore MySQL AUTO_INCREMENT counter values (the column flag is still compared). */
  readonly ignoreAutoIncrement?: boolean;
  /** Ignore MySQL DEFINER of routines and views; scripts then omit DEFINER. */
  readonly ignoreDefiner?: boolean;
  /** Ignore PostgreSQL object owners; scripts then omit OWNER TO. */
  readonly ignoreOwnership?: boolean;
  /** Privileges are not part of snapshots yet; accepted for profile compatibility. */
  readonly ignorePrivileges?: boolean;
  /** Ignore partitioning clauses (MySQL) and partition lists (PostgreSQL). */
  readonly ignorePartitions?: boolean;
  /**
   * Ignore MySQL/MariaDB column order. PostgreSQL column order is always ignored: it cannot be
   * changed without rebuilding the table.
   */
  readonly ignoreColumnOrder?: boolean;
  /**
   * Match names case-insensitively and ignore case-only differences (MySQL/MariaDB, where
   * lower_case_table_names differs between servers). PostgreSQL names are case-sensitive and
   * scripts address objects by name, so there the option is ignored with a warning.
   */
  readonly ignoreNameCase?: boolean;
  /**
   * Ignore index and constraint names: match them by definition. Covers generated names
   * (PostgreSQL `t_pkey`, `t_a_key`, `t_a_fkey`, `t_a_check`, `t_a_idx`; MySQL `t_ibfk_N`,
   * `t_chk_N` and FK-backing indexes), which the scripts then let the server generate.
   */
  readonly ignoreNames?: boolean;
  /** Ignore PostgreSQL extension versions (the extension itself is still compared). */
  readonly ignoreExtensionVersions?: boolean;
  /**
   * Turn a drop + create of an index or constraint with an identical definition into a rename.
   * Only where the engine can rename it (PostgreSQL constraints and indexes, MySQL indexes).
   */
  readonly detectRenames?: boolean;
  readonly renames?: readonly RenameRule[];
}

/** Options with every default filled in; diffs carry the ones they were computed with. */
export type ResolvedCompareOptions = Required<CompareOptions>;

/** Defaults: counters, definers, owners and privileges are ignored; everything else compares. */
export const DEFAULT_COMPARE_OPTIONS: ResolvedCompareOptions = {
  ignoreComments: false,
  ignoreCollation: false,
  ignoreAutoIncrement: true,
  ignoreDefiner: true,
  ignoreOwnership: true,
  ignorePrivileges: true,
  ignorePartitions: false,
  ignoreColumnOrder: false,
  ignoreNameCase: false,
  ignoreNames: false,
  ignoreExtensionVersions: false,
  detectRenames: true,
  renames: [],
};

/** Fills in defaults; explicit `undefined` values count as not set. */
export function resolveCompareOptions(options: CompareOptions = {}): ResolvedCompareOptions {
  const resolved: Record<string, unknown> = { ...DEFAULT_COMPARE_OPTIONS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved as ResolvedCompareOptions;
}
