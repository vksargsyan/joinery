import { formatShell, fromEjson } from '@joinery/mongo-tools';

import { formatCount } from '../../lib/format';
import {
  buildExpiryChange,
  dropCollectionCommand,
  renameCommand,
  useCollectionOptions,
  type CollectionOptions,
} from '../../state/mongo/collection-options';
import { formatBytes } from '../../state/mongo/indexes';
import { useTheme } from '../theme';
import { Button, Input } from '../ui';
import { CommandPreview, Labelled, NoticeBanner, RulesBanners, SmallSelect } from './parts';
import { ShellEditor } from './ShellEditor';

/**
 * The options of one collection (spec §9, collection options): what it is (type, capped, time
 * series, clustered, collation, statistics), its validation rules edited through collMod, the
 * expiry of a time series or clustered collection, rename and drop. Each change shows its
 * command here and again in the confirmation.
 */
export function CollectionOptionsPanel({ panel }: { readonly panel: CollectionOptions }) {
  const theme = useTheme();
  const info = useCollectionOptions(panel, (s) => s.info);
  const loading = useCollectionOptions(panel, (s) => s.loading);
  const error = useCollectionOptions(panel, (s) => s.error);
  const validation = useCollectionOptions(panel, (s) => s.validation);
  const expiry = useCollectionOptions(panel, (s) => s.expiry);
  const renameTo = useCollectionOptions(panel, (s) => s.renameTo);
  const dropTarget = useCollectionOptions(panel, (s) => s.dropTarget);
  const saving = useCollectionOptions(panel, (s) => s.saving);
  const notice = useCollectionOptions(panel, (s) => s.notice);
  const gone = useCollectionOptions(panel, (s) => s.gone);
  const rules = useCollectionOptions(panel, (s) => s.rules);
  const writable = !rules.readOnlyProfile && !gone;
  const { db, collection } = panel.target;
  const change = info ? panel.validationChange() : undefined;
  const expiryChange = buildExpiryChange(panel.ns, expiry);
  const id = (name: string): string => `${panel.id}-${name}`;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-options-panel"
      aria-label={`${db}.${collection} options`}
    >
      <div
        className="flex items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Collection options"
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void panel.load()}
          disabled={loading || gone}
        >
          Refresh
        </Button>
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
      </div>
      <RulesBanners rules={rules} what="the options" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      {error && (
        <p role="alert" className="p-4 text-sm text-danger">
          {error}
        </p>
      )}
      {gone ? (
        <p className="p-4 text-sm text-muted">The collection was dropped.</p>
      ) : (
        info && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3 text-xs">
            <section aria-label="Overview" data-testid="options-overview">
              <dl className="grid grid-cols-4 gap-2">
                {(
                  [
                    [
                      'Type',
                      info.type === 'timeseries'
                        ? 'time series'
                        : info.type === 'view'
                          ? 'view'
                          : info.capped
                            ? 'capped collection'
                            : info.clustered
                              ? 'clustered collection'
                              : 'collection',
                    ],
                    [
                      'Documents',
                      info.stats?.count === undefined ? '–' : formatCount(info.stats.count),
                    ],
                    ['Data size', formatBytes(info.stats?.size)],
                    ['Index size', formatBytes(info.stats?.totalIndexSize)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded border border-border bg-panel-2 px-2 py-1">
                    <dt className="text-[11px] text-muted">{label}</dt>
                    <dd
                      className="font-mono"
                      data-testid={`options-${label.toLowerCase().replace(' ', '-')}`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              {info.timeseries && (
                <p className="mt-2 font-mono text-muted" data-testid="options-timeseries">
                  timeField: {info.timeseries.timeField}
                  {info.timeseries.metaField ? ` · metaField: ${info.timeseries.metaField}` : ''}
                  {info.timeseries.granularity
                    ? ` · granularity: ${info.timeseries.granularity}`
                    : ''}
                </p>
              )}
              {info.viewOn !== undefined && (
                <div className="mt-2 flex flex-col gap-1">
                  <p className="text-muted">
                    View on <span className="font-mono text-fg">{info.viewOn}</span>
                  </p>
                  <pre className="rounded border border-border bg-panel-2 p-2 font-mono select-text">
                    {info.pipeline ? formatShell(fromEjson(info.pipeline, 'pipeline')) : '[]'}
                  </pre>
                </div>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-muted">All options</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono select-text">
                  {formatShell(fromEjson(info.options, 'options'))}
                </pre>
              </details>
            </section>

            {info.type !== 'view' && (
              <section className="flex flex-col gap-2" aria-label="Validation">
                <h3 className="text-[13px] font-semibold">Validation</h3>
                <div className="h-40 rounded border border-border">
                  <ShellEditor
                    value={validation.validator}
                    onChange={(text) => panel.setValidation({ validator: text })}
                    theme={theme}
                    readOnly={!writable}
                    ariaLabel="Validator"
                    testId="options-validator"
                  />
                </div>
                <p className="text-[11px] text-muted">
                  A query document or {'{ $jsonSchema: … }'}; leave it empty to remove the
                  validator.
                </p>
                <div className="flex gap-2">
                  <Labelled label="Validation level" htmlFor={id('level')}>
                    <SmallSelect
                      id={id('level')}
                      value={validation.validationLevel}
                      disabled={!writable}
                      onChange={(event) =>
                        panel.setValidation({
                          validationLevel: event.target.value as 'strict' | 'moderate' | 'off',
                        })
                      }
                      className="w-40"
                    >
                      <option value="strict">strict</option>
                      <option value="moderate">moderate</option>
                      <option value="off">off</option>
                    </SmallSelect>
                  </Labelled>
                  <Labelled label="Validation action" htmlFor={id('action')}>
                    <SmallSelect
                      id={id('action')}
                      value={validation.validationAction}
                      disabled={!writable}
                      onChange={(event) =>
                        panel.setValidation({
                          validationAction: event.target.value as 'error' | 'warn' | 'errorAndLog',
                        })
                      }
                      className="w-40"
                    >
                      <option value="error">error</option>
                      <option value="warn">warn</option>
                      <option value="errorAndLog">errorAndLog</option>
                    </SmallSelect>
                  </Labelled>
                </div>
                {change && !change.ok && (
                  <p role="alert" className="text-danger">
                    {Object.values(change.issues)[0]}
                  </p>
                )}
                <CommandPreview
                  command={change?.ok ? change.plan.command : 'No changes'}
                  testId="options-validation-command"
                />
                <div>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!writable || saving || !change?.ok}
                    onClick={() => void panel.saveValidation()}
                    data-testid="options-save-validation"
                  >
                    Save validation…
                  </Button>
                </div>
              </section>
            )}

            {(info.type === 'timeseries' || info.clustered) && (
              <section className="flex flex-col gap-2" aria-label="Expiry">
                <h3 className="text-[13px] font-semibold">Expiry</h3>
                <Labelled
                  label="Delete documents after (seconds; empty or off for never)"
                  htmlFor={id('expiry')}
                  error={expiryChange.ok ? undefined : Object.values(expiryChange.issues)[0]}
                >
                  <Input
                    id={id('expiry')}
                    value={expiry}
                    disabled={!writable}
                    onChange={(event) => panel.setExpiry(event.target.value)}
                    className="w-48"
                    data-testid="options-expiry"
                  />
                </Labelled>
                <CommandPreview command={expiryChange.ok ? expiryChange.plan.command : undefined} />
                <div>
                  <Button
                    size="sm"
                    disabled={!writable || saving || !expiryChange.ok}
                    onClick={() => void panel.saveExpiry()}
                  >
                    Save expiry…
                  </Button>
                </div>
              </section>
            )}

            <section className="flex flex-col gap-2" aria-label="Rename">
              <h3 className="text-[13px] font-semibold">Rename</h3>
              <div className="flex items-end gap-2">
                <Labelled label="New name" htmlFor={id('rename')}>
                  <Input
                    id={id('rename')}
                    value={renameTo}
                    disabled={!writable}
                    onChange={(event) => panel.setRename(event.target.value)}
                    className="h-7 w-64 font-mono text-xs"
                    data-testid="options-rename"
                  />
                </Labelled>
                <label className="flex items-center gap-1.5 pb-1.5">
                  <input
                    type="checkbox"
                    checked={dropTarget}
                    disabled={!writable}
                    onChange={(event) => panel.setRename(renameTo, event.target.checked)}
                  />
                  Replace an existing collection of that name
                </label>
              </div>
              <CommandPreview command={renameCommand(panel.ns, renameTo.trim(), dropTarget)} />
              <div>
                <Button
                  size="sm"
                  disabled={!writable || renameTo.trim() === '' || renameTo.trim() === collection}
                  onClick={() => void panel.rename()}
                >
                  Rename…
                </Button>
              </div>
            </section>

            <section className="flex flex-col gap-2" aria-label="Drop">
              <h3 className="text-[13px] font-semibold text-danger">Drop</h3>
              <CommandPreview command={dropCollectionCommand(panel.ns)} />
              <div>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!writable}
                  onClick={() => void panel.drop()}
                  data-testid="options-drop"
                >
                  Drop {info.type === 'view' ? 'view' : 'collection'}…
                </Button>
              </div>
            </section>
          </div>
        )
      )}
    </div>
  );
}
