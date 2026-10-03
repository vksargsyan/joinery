import { ENGINES } from '@querybara/core';

import type { TransferDbState } from '../../state/transfer-db/wizard';

/**
 * The review (spec §12): where from and where to, what is created, emptied and dropped, the
 * statements before and after the data, and what the job runner warns about. The job does
 * exactly this: it plans again on fresh sessions and refuses to run if the plan changed into
 * something unconfirmed.
 */

export function ReviewStep({ state }: { readonly state: TransferDbState }) {
  const { plan, source, target, options } = state;
  if (plan === undefined || source === undefined || target === undefined) {
    return <p className="text-xs text-muted">{state.planError ?? 'Planning the transfer…'}</p>;
  }
  const redis = source.engine === 'redis';
  const where = (name: string, database?: string, schema?: string): string =>
    [name, database, schema].filter((part) => part !== undefined && part !== '').join(' · ');
  const rows: [string, string][] = [
    [
      'From',
      `${where(source.profileName, state.sourceDatabase, source.engine === 'postgres' ? state.sourceSchema : undefined)} (${ENGINES[source.engine].displayName} ${plan.sourceVersion})`,
    ],
    [
      'To',
      `${where(target.profileName, state.targetDatabase, target.engine === 'postgres' ? state.targetSchema : undefined)} (${ENGINES[target.engine].displayName} ${plan.targetVersion})`,
    ],
    [
      redis ? 'Keys' : 'Tables',
      plan.tables
        .map((t) => (t.source === t.target ? t.source : `${t.source} → ${t.target}`))
        .join(', '),
    ],
    [
      'Options',
      redis
        ? `${options.replace ? 'replace existing keys' : 'skip existing keys'} · ${options.keepTtl ? 'keep TTLs' : 'no TTLs'} · ${options.batchSize.toLocaleString('en-US')} keys per batch`
        : `${options.batchSize.toLocaleString('en-US')} rows per batch · ${options.parallel} at once · ${
            options.onError === 'stop'
              ? 'stop at the first failed row'
              : 'log failed rows and go on'
          }${target.engine !== 'mongodb' && options.transactionPerBatch ? ' · a transaction per batch' : ''}${
            target.engine !== 'mongodb' && options.disableConstraints
              ? ' · constraint checks off'
              : ''
          }`,
    ],
  ];
  const statements = [...plan.before, ...plan.after];
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="transfer-review">
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {plan.creates.length > 0 && (
        <div>
          <h3 className="mb-1 text-[11px] font-medium text-muted">Created</h3>
          <ul className="list-inside list-disc" data-testid="transfer-creates">
            {plan.creates.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.destructive.length > 0 && (
        <div role="alert">
          <h3 className="mb-1 text-[11px] font-medium text-danger">
            Dropped, emptied or overwritten
          </h3>
          <ul
            className="list-inside list-disc font-medium text-danger"
            data-testid="transfer-destructive"
          >
            {plan.destructive.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.problems.length > 0 && (
        <ul className="text-danger" role="alert">
          {plan.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className="list-inside list-disc text-warning">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {statements.length > 0 && (
        <pre
          className="max-h-56 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap"
          data-testid="transfer-ddl"
        >
          {plan.before.map((s) => `${s};`).join('\n\n')}
          {plan.before.length > 0 && plan.after.length > 0 ? '\n\n-- After the data\n\n' : ''}
          {plan.after.map((s) => `${s};`).join('\n\n')}
        </pre>
      )}
      {target.production && (
        <p className="font-medium text-danger">This is a production connection.</p>
      )}
      <p className="text-muted">
        The transfer runs as a job: follow it, or cancel it, in the Jobs panel.
      </p>
    </div>
  );
}
