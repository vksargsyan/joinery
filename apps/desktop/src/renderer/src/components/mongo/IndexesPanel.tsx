import { formatCount } from '../../lib/format';
import {
  formatBytes,
  indexBadges,
  keysText,
  useIndexManager,
  type IndexManager,
  type IndexPreset,
  type KeyType,
} from '../../state/mongo/indexes';
import { Button, Icon, Input, Modal, cx } from '../ui';
import {
  CommandPreview,
  Labelled,
  NoticeBanner,
  RulesBanners,
  ShellInput,
  SmallSelect,
} from './parts';

/**
 * The index manager panel (spec §9): the collection's indexes (keys, type badges, size, usage
 * since the counter started, hidden), hide/unhide and drop, and the create dialog for every
 * kind of index with the exact `createIndex` command shown as the form changes.
 */
export function IndexesPanel({ manager }: { readonly manager: IndexManager }) {
  const indexes = useIndexManager(manager, (s) => s.indexes);
  const loading = useIndexManager(manager, (s) => s.loading);
  const error = useIndexManager(manager, (s) => s.error);
  const notice = useIndexManager(manager, (s) => s.notice);
  const rules = useIndexManager(manager, (s) => s.rules);
  const busy = useIndexManager(manager, (s) => s.busy);
  const writable = !rules.readOnlyProfile;
  const { db, collection } = manager.target;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-indexes-panel"
      aria-label={`${db}.${collection} indexes`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Indexes"
      >
        <Button
          size="sm"
          variant="primary"
          disabled={!writable}
          onClick={() => manager.openCreate()}
          data-testid="index-create"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Create index…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void manager.load()} disabled={loading}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
      </div>
      <RulesBanners rules={rules} what="indexes" />
      <NoticeBanner notice={notice} onDismiss={() => manager.dismissNotice()} />
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p role="alert" className="p-4 text-sm text-danger">
            {error}
          </p>
        ) : (
          <table className="w-full border-collapse text-xs" data-testid="index-list">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1 font-medium">Name</th>
                <th className="border-b border-border px-2 py-1 font-medium">Keys</th>
                <th className="border-b border-border px-2 py-1 font-medium">Type</th>
                <th className="border-b border-border px-2 py-1 font-medium">Options</th>
                <th className="border-b border-border px-2 py-1 text-right font-medium">Size</th>
                <th className="border-b border-border px-2 py-1 text-right font-medium">Usage</th>
                <th className="border-b border-border px-2 py-1 font-medium">Hidden</th>
                <th className="border-b border-border px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {indexes.map((index) => {
                const badges = indexBadges(index);
                const system = index.name === '_id_';
                return (
                  <tr
                    key={index.name}
                    data-index={index.name}
                    className={cx('hover:bg-hover', index.hidden && 'text-muted')}
                  >
                    <td className="border-b border-border px-2 py-1 font-mono">{index.name}</td>
                    <td className="border-b border-border px-2 py-1 font-mono">
                      {keysText(index)}
                    </td>
                    <td className="border-b border-border px-2 py-1">
                      <span className="flex flex-wrap gap-1" data-testid="index-badges">
                        {badges.map((badge) => (
                          <span
                            key={badge}
                            className="rounded border border-border bg-panel-2 px-1 text-[10px]"
                          >
                            {badge}
                          </span>
                        ))}
                        {index.building && (
                          <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">
                            building
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="border-b border-border px-2 py-1 font-mono text-[11px] text-muted">
                      {[
                        index.expireAfterSeconds !== undefined
                          ? `expireAfterSeconds: ${index.expireAfterSeconds}`
                          : undefined,
                        index.partialFilterExpression !== undefined
                          ? `partial: ${keysText({ keys: index.partialFilterExpression })}`
                          : undefined,
                        index.wildcardProjection !== undefined
                          ? `projection: ${keysText({ keys: index.wildcardProjection })}`
                          : undefined,
                        index.collation !== undefined ? 'collation' : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    <td className="border-b border-border px-2 py-1 text-right">
                      {formatBytes(index.size)}
                    </td>
                    <td
                      className="border-b border-border px-2 py-1 text-right"
                      title={
                        index.usageSince
                          ? `Since ${new Date(index.usageSince).toLocaleString()}`
                          : undefined
                      }
                    >
                      {index.usageOps === undefined ? '–' : `${formatCount(index.usageOps)} ops`}
                    </td>
                    <td className="border-b border-border px-2 py-1">
                      {index.hidden ? 'hidden' : ''}
                    </td>
                    <td className="border-b border-border px-2 py-1 text-right whitespace-nowrap">
                      {!system && writable && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === index.name}
                            onClick={() => void manager.setHidden(index.name, !index.hidden)}
                            aria-label={`${index.hidden ? 'Unhide' : 'Hide'} ${index.name}`}
                          >
                            {index.hidden ? 'Unhide' : 'Hide'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger"
                            disabled={busy === index.name}
                            onClick={() => void manager.drop(index.name)}
                            aria-label={`Drop ${index.name}`}
                          >
                            Drop…
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {loading && <p className="px-3 py-2 text-xs text-muted">Loading…</p>}
      </div>
      <footer className="border-t border-border bg-panel px-2 py-1 text-xs text-muted">
        {formatCount(indexes.length)} {indexes.length === 1 ? 'index' : 'indexes'} · usage from
        $indexStats counts operations since each index was built or the server restarted
      </footer>
      <CreateIndexDialog manager={manager} />
    </div>
  );
}

const PRESETS: readonly { readonly value: IndexPreset; readonly label: string }[] = [
  { value: 'single', label: 'Single field' },
  { value: 'compound', label: 'Compound' },
  { value: 'ttl', label: 'TTL' },
  { value: 'partial', label: 'Partial' },
  { value: 'text', label: 'Text' },
  { value: '2dsphere', label: '2dsphere' },
  { value: 'hashed', label: 'Hashed' },
  { value: 'wildcard', label: 'Wildcard' },
];

const KEY_TYPES: readonly { readonly value: KeyType; readonly label: string }[] = [
  { value: '1', label: '1 (ascending)' },
  { value: '-1', label: '-1 (descending)' },
  { value: 'text', label: 'text' },
  { value: '2dsphere', label: '2dsphere' },
  { value: '2d', label: '2d' },
  { value: 'hashed', label: 'hashed' },
];

function CreateIndexDialog({ manager }: { readonly manager: IndexManager }) {
  const create = useIndexManager(manager, (s) => s.create);
  if (!create) return null;
  const { form, built } = create;
  const issues = built.ok ? {} : built.issues;
  const id = (name: string): string => `${manager.id}-index-${name}`;
  const docField = (
    name: 'partialFilter' | 'collation' | 'wildcardProjection' | 'weights',
    label: string,
    placeholder: string,
  ) => (
    <Labelled label={label} htmlFor={id(name)}>
      <ShellInput
        id={id(name)}
        value={form[name]}
        onChange={(text) => manager.updateForm({ [name]: text })}
        placeholder={placeholder}
        issue={issues[name]}
        data-testid={`index-${name}`}
      />
    </Labelled>
  );
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !create.creating && manager.closeCreate()}
      title={`Create an index on ${manager.target.collection}`}
      width="w-[760px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => manager.closeCreate()} disabled={create.creating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!built.ok || create.creating}
            onClick={() => void manager.create()}
            data-testid="index-create-run"
          >
            {create.creating ? 'Creating…' : 'Create index'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="index-dialog">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Kind of index">
          {PRESETS.map((preset) => (
            <Button
              key={preset.value}
              size="sm"
              variant="secondary"
              onClick={() => manager.applyPreset(preset.value)}
              data-testid={`index-preset-${preset.value}`}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] font-medium text-muted">Keys</legend>
          {form.keys.map((key, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                aria-label={`Key ${i + 1} field`}
                placeholder="field.path or $**"
                value={key.field}
                onChange={(event) => manager.setKey(i, { field: event.target.value })}
                className="h-7 font-mono text-xs"
                data-testid="index-key-field"
              />
              <SmallSelect
                aria-label={`Key ${i + 1} type`}
                value={key.type}
                onChange={(event) => manager.setKey(i, { type: event.target.value as KeyType })}
                className="w-44"
                data-testid="index-key-type"
              >
                {KEY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </SmallSelect>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove key ${i + 1}`}
                disabled={form.keys.length <= 1}
                onClick={() => manager.removeKey(i)}
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" variant="ghost" onClick={() => manager.addKey()}>
              <Icon name="plus" className="h-3.5 w-3.5" />
              Add key
            </Button>
          </div>
          {issues.keys && (
            <p role="alert" className="text-[11px] text-danger">
              {issues.keys}
            </p>
          )}
        </fieldset>
        <div className="grid grid-cols-3 gap-2">
          <Labelled label="Name (optional)" htmlFor={id('name')} error={issues.name}>
            <Input
              id={id('name')}
              value={form.name}
              placeholder={built.ok ? built.plan.name : ''}
              onChange={(event) => manager.updateForm({ name: event.target.value })}
              className="h-7 font-mono text-xs"
              data-testid="index-name"
            />
          </Labelled>
          <Labelled label="TTL seconds (expireAfterSeconds)" htmlFor={id('ttl')} error={issues.ttl}>
            <Input
              id={id('ttl')}
              value={form.ttl}
              placeholder="none"
              inputMode="numeric"
              onChange={(event) => manager.updateForm({ ttl: event.target.value })}
              className="w-full"
              data-testid="index-ttl"
            />
          </Labelled>
          <Labelled
            label="Default language (text)"
            htmlFor={id('lang')}
            error={issues.defaultLanguage}
          >
            <Input
              id={id('lang')}
              value={form.defaultLanguage}
              placeholder="english"
              onChange={(event) => manager.updateForm({ defaultLanguage: event.target.value })}
              className="w-full"
            />
          </Labelled>
        </div>
        <div className="flex flex-wrap gap-4">
          {(['unique', 'sparse', 'hidden'] as const).map((flag) => (
            <label key={flag} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form[flag]}
                onChange={(event) => manager.updateForm({ [flag]: event.target.checked })}
                data-testid={`index-${flag}`}
              />
              {flag === 'unique'
                ? 'Unique'
                : flag === 'sparse'
                  ? 'Sparse'
                  : 'Hidden (built, not used)'}
            </label>
          ))}
        </div>
        {(issues.unique || issues.sparse) && (
          <p role="alert" className="text-[11px] text-danger">
            {issues.unique ?? issues.sparse}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {docField('partialFilter', 'Partial filter expression', "{ status: { $eq: 'open' } }")}
          {docField('collation', 'Collation', "{ locale: 'en', strength: 2 }")}
          {docField('wildcardProjection', 'Wildcard projection ($**)', '{ details: 1 }')}
          {docField('weights', 'Text weights', '{ title: 10, body: 1 }')}
        </div>
        <CommandPreview
          command={built.ok ? built.plan.command : undefined}
          testId="index-command"
        />
        {create.error && (
          <p role="alert" className="text-danger" data-testid="index-error">
            {create.error}
          </p>
        )}
      </div>
    </Modal>
  );
}
