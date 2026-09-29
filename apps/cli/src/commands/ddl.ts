import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { IntrospectScope } from '@joinery/core';
import { renderSnapshotDdl } from '@joinery/sync';

import { closeQuietly } from '../connect';
import { EXIT, type ExitCode } from '../errors';
import { openTarget, plural, type Runtime } from '../runtime';
import type { TargetOverrides } from '../target';

export interface DdlOptions extends TargetOverrides {
  /** PostgreSQL schemas to dump; empty: every non-system schema. */
  readonly schemas: readonly string[];
  /** Write here instead of stdout. */
  readonly out?: string;
}

/**
 * `joinery ddl <target>`: the schema as a DDL script (introspect + renderSnapshotDdl), in
 * dependency order, ready to create the objects in an empty database.
 */
export async function ddlCommand(
  runtime: Runtime,
  spec: string,
  options: DdlOptions,
): Promise<ExitCode> {
  const connection = await openTarget(runtime, spec, options);
  try {
    const { session } = connection;
    if (session.engine !== 'postgres' && options.schemas.length > 0) {
      runtime.reporter.warn(
        '--schema applies to PostgreSQL; MySQL and MariaDB dump the connected database',
      );
    }
    const scope: IntrospectScope =
      session.engine === 'postgres' && options.schemas.length > 0
        ? { schemas: options.schemas }
        : {};
    runtime.reporter.progress(`Reading the structure of ${connection.target.label}…`, true);
    const snapshot = await session.introspect(scope);
    runtime.reporter.clearProgress();
    const script = renderSnapshotDdl(snapshot);
    const header = `-- ${connection.target.label}: ${snapshot.engine} ${snapshot.serverVersion ?? ''} database ${snapshot.database}\n`;
    const text = `${header}${script.text}`;
    if (options.out !== undefined && options.out !== '-') {
      writeFileSync(resolve(runtime.ctx.cwd, options.out), text);
      runtime.reporter.info(
        `Wrote ${plural(script.statements.length, 'statement')} to ${options.out}`,
      );
    } else {
      await runtime.stdout.write(text);
    }
    return EXIT.ok;
  } finally {
    await closeQuietly(connection.session);
  }
}
