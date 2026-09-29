import {
  buildCreateCollection,
  buildCreateView,
  type NewCollectionKind,
} from '../../state/mongo/collection-options';
import {
  closeMongoDialog,
  submitMongoDialog,
  updateCollectionForm,
  updateViewForm,
  useMongoDialogs,
  viewStages,
  type MongoDialog,
} from '../../state/mongo/create-dialogs';
import { checkStages } from '../../state/mongo/stage-list';
import { useTheme } from '../theme';
import { Button, Input, Modal } from '../ui';
import { CommandPreview, Labelled, Segmented, ShellInput, SmallSelect } from './parts';
import { ShellEditor } from './ShellEditor';
import { StageCards } from './StageCards';

/**
 * The create collection and create view dialogs (spec §9, collection options), shown for the
 * connection whose explorer opened them. Both show the exact command as the form changes; the
 * confirmation shows it again before it runs.
 */
export function MongoCreateDialogs(props: { readonly profileId: string }) {
  const dialog = useMongoDialogs((s) => s.dialog);
  if (!dialog || dialog.profileId !== props.profileId) return null;
  return dialog.kind === 'create-collection' ? (
    <CreateCollectionDialog dialog={dialog} />
  ) : (
    <CreateViewDialog dialog={dialog} />
  );
}

const KINDS: readonly { readonly value: NewCollectionKind; readonly label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'capped', label: 'Capped' },
  { value: 'timeseries', label: 'Time series' },
  { value: 'clustered', label: 'Clustered' },
];

function CreateCollectionDialog(props: {
  readonly dialog: Extract<MongoDialog, { kind: 'create-collection' }>;
}) {
  const theme = useTheme();
  const { dialog } = props;
  const { form } = dialog;
  const built = buildCreateCollection(dialog.db, form);
  const issues: Readonly<Record<string, string>> = built.ok ? {} : built.issues;
  const id = (name: string): string => `create-collection-${name}`;
  const kinds = KINDS.filter((k) => k.value !== 'clustered' || dialog.clusteredSupported !== false);
  const validatorEditor = (
    <Labelled
      label="Validator (optional): a query or { $jsonSchema: … }"
      htmlFor={id('validator')}
      error={issues['validator']}
    >
      <div className="h-24 rounded border border-border">
        <ShellEditor
          value={form.validator}
          onChange={(text) => updateCollectionForm({ validator: text })}
          theme={theme}
          ariaLabel="Validator"
          testId="create-collection-validator"
        />
      </div>
    </Labelled>
  );
  return (
    <Modal
      open
      onOpenChange={(open) => !open && closeMongoDialog()}
      title={`Create a collection in ${dialog.db}`}
      width="w-[720px]"
      footer={
        <>
          <Button variant="ghost" onClick={closeMongoDialog} disabled={dialog.creating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!built.ok || dialog.creating}
            onClick={() => void submitMongoDialog()}
            data-testid="create-collection-run"
          >
            {dialog.creating ? 'Creating…' : 'Create…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="create-collection-dialog">
        <Labelled
          label="Name"
          htmlFor={id('name')}
          error={form.name === '' ? undefined : issues['name']}
        >
          <Input
            id={id('name')}
            autoFocus
            value={form.name}
            onChange={(event) => updateCollectionForm({ name: event.target.value })}
            className="h-7 font-mono text-xs"
            data-testid="create-collection-name"
          />
        </Labelled>
        <Segmented
          label="Kind"
          value={form.kind}
          options={kinds}
          onChange={(kind) => updateCollectionForm({ kind })}
        />
        {dialog.clusteredSupported === false && (
          <p className="text-[11px] text-muted">Clustered collections need MongoDB 5.3 or later.</p>
        )}
        {form.kind === 'capped' && (
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Size (bytes)" htmlFor={id('size')} error={issues['cappedSize']}>
              <Input
                id={id('size')}
                value={form.cappedSize}
                inputMode="numeric"
                onChange={(event) => updateCollectionForm({ cappedSize: event.target.value })}
                className="w-full"
                data-testid="create-collection-size"
              />
            </Labelled>
            <Labelled
              label="Most documents (optional)"
              htmlFor={id('max')}
              error={issues['cappedMax']}
            >
              <Input
                id={id('max')}
                value={form.cappedMax}
                inputMode="numeric"
                onChange={(event) => updateCollectionForm({ cappedMax: event.target.value })}
                className="w-full"
                data-testid="create-collection-max"
              />
            </Labelled>
          </div>
        )}
        {form.kind === 'timeseries' && (
          <div className="grid grid-cols-3 gap-2">
            <Labelled label="Time field" htmlFor={id('time')} error={issues['timeField']}>
              <Input
                id={id('time')}
                value={form.timeField}
                onChange={(event) => updateCollectionForm({ timeField: event.target.value })}
                className="h-7 font-mono text-xs"
                data-testid="create-collection-time-field"
              />
            </Labelled>
            <Labelled
              label="Meta field (optional)"
              htmlFor={id('meta')}
              error={issues['metaField']}
            >
              <Input
                id={id('meta')}
                value={form.metaField}
                onChange={(event) => updateCollectionForm({ metaField: event.target.value })}
                className="h-7 font-mono text-xs"
                data-testid="create-collection-meta-field"
              />
            </Labelled>
            <Labelled label="Granularity" htmlFor={id('granularity')}>
              <SmallSelect
                id={id('granularity')}
                value={form.granularity}
                onChange={(event) =>
                  updateCollectionForm({
                    granularity: event.target.value as '' | 'seconds' | 'minutes' | 'hours',
                  })
                }
                className="w-full"
                data-testid="create-collection-granularity"
              >
                <option value="">server default (seconds)</option>
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </SmallSelect>
            </Labelled>
          </div>
        )}
        {(form.kind === 'timeseries' || form.kind === 'clustered') && (
          <Labelled
            label="Delete documents after (seconds, optional)"
            htmlFor={id('expire')}
            error={issues['expireAfterSeconds']}
          >
            <Input
              id={id('expire')}
              value={form.expireAfterSeconds}
              inputMode="numeric"
              onChange={(event) => updateCollectionForm({ expireAfterSeconds: event.target.value })}
              className="w-48"
              data-testid="create-collection-expire"
            />
          </Labelled>
        )}
        <Labelled label="Collation (optional)" htmlFor={id('collation')}>
          <ShellInput
            id={id('collation')}
            value={form.collation}
            onChange={(text) => updateCollectionForm({ collation: text })}
            placeholder="{ locale: 'en', strength: 2 }"
            issue={issues['collation']}
            data-testid="create-collection-collation"
          />
        </Labelled>
        {form.kind !== 'timeseries' && (
          <>
            {validatorEditor}
            <div className="flex gap-2">
              <Labelled label="Validation level" htmlFor={id('level')}>
                <SmallSelect
                  id={id('level')}
                  value={form.validationLevel}
                  onChange={(event) =>
                    updateCollectionForm({
                      validationLevel: event.target.value as '' | 'strict' | 'moderate' | 'off',
                    })
                  }
                  className="w-40"
                >
                  <option value="">default (strict)</option>
                  <option value="strict">strict</option>
                  <option value="moderate">moderate</option>
                  <option value="off">off</option>
                </SmallSelect>
              </Labelled>
              <Labelled label="Validation action" htmlFor={id('action')}>
                <SmallSelect
                  id={id('action')}
                  value={form.validationAction}
                  onChange={(event) =>
                    updateCollectionForm({
                      validationAction: event.target.value as '' | 'error' | 'warn' | 'errorAndLog',
                    })
                  }
                  className="w-40"
                >
                  <option value="">default (error)</option>
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="errorAndLog">errorAndLog</option>
                </SmallSelect>
              </Labelled>
            </div>
          </>
        )}
        <CommandPreview
          command={built.ok ? built.plan.command : undefined}
          testId="create-collection-command"
        />
        {dialog.error && (
          <p role="alert" className="text-danger" data-testid="create-dialog-error">
            {dialog.error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function CreateViewDialog(props: {
  readonly dialog: Extract<MongoDialog, { kind: 'create-view' }>;
}) {
  const theme = useTheme();
  const { dialog } = props;
  const { form } = dialog;
  const built = buildCreateView(dialog.db, form);
  const issues: Readonly<Record<string, string>> = built.ok ? {} : built.issues;
  const checks = checkStages(form.stages);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && closeMongoDialog()}
      title={`Create a view in ${dialog.db}`}
      width="w-[820px]"
      footer={
        <>
          <Button variant="ghost" onClick={closeMongoDialog} disabled={dialog.creating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!built.ok || dialog.creating}
            onClick={() => void submitMongoDialog()}
            data-testid="create-view-run"
          >
            {dialog.creating ? 'Creating…' : 'Create…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="create-view-dialog">
        <div className="grid grid-cols-2 gap-2">
          <Labelled
            label="View name"
            htmlFor="create-view-name"
            error={form.name === '' ? undefined : issues['name']}
          >
            <Input
              id="create-view-name"
              autoFocus
              value={form.name}
              onChange={(event) => updateViewForm({ name: event.target.value })}
              className="h-7 font-mono text-xs"
              data-testid="create-view-name"
            />
          </Labelled>
          <Labelled
            label="Source collection or view"
            htmlFor="create-view-source"
            error={form.source === '' ? undefined : issues['source']}
          >
            <Input
              id="create-view-source"
              list="create-view-sources"
              value={form.source}
              onChange={(event) => updateViewForm({ source: event.target.value })}
              className="h-7 font-mono text-xs"
              data-testid="create-view-source"
            />
            <datalist id="create-view-sources">
              {dialog.sources.map((source) => (
                <option key={source} value={source} />
              ))}
            </datalist>
          </Labelled>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">Pipeline</span>
          <StageCards
            stages={form.stages}
            checks={checks}
            theme={theme}
            actions={{
              add: (after) => viewStages.add(after),
              remove: (id) => viewStages.remove(id),
              move: (from, to) => viewStages.move(from, to),
              toggle: (id) => viewStages.toggle(id),
              setOperator: (id, op) => viewStages.setOperator(id, op),
              setBody: (id, body) => viewStages.setBody(id, body),
            }}
          />
          {issues['stages'] && (
            <p role="alert" className="text-[11px] text-danger">
              {issues['stages']}
            </p>
          )}
        </div>
        <Labelled label="Collation (optional)" htmlFor="create-view-collation">
          <ShellInput
            id="create-view-collation"
            value={form.collation}
            onChange={(text) => updateViewForm({ collation: text })}
            placeholder="{ locale: 'en' }"
            issue={issues['collation']}
          />
        </Labelled>
        <CommandPreview
          command={built.ok ? built.plan.command : undefined}
          testId="create-view-command"
        />
        {dialog.error && (
          <p role="alert" className="text-danger" data-testid="create-dialog-error">
            {dialog.error}
          </p>
        )}
      </div>
    </Modal>
  );
}
