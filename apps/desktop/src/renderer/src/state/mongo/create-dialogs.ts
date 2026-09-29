import { create } from 'zustand';

import { errorMessage } from '../../lib/errors';
import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';
import {
  EMPTY_COLLECTION_FORM,
  buildCreateCollection,
  buildCreateView,
  folderOf,
  supportsClustered,
  type CreateCollectionForm,
  type CreateViewForm,
  type NewCollectionKind,
} from './collection-options';
import {
  insertStage,
  moveStage,
  newStage,
  removeStage,
  setStageBody,
  setStageOperator,
  toggleStage,
  type PipelineStage,
} from './stage-list';
import { confirmMongoWrite, loadWriteRules } from './write-rules';

/**
 * The create collection and create view dialogs (spec §9, collection options), opened from a
 * database in the explorer. One dialog is open at a time; it runs on its own session and
 * reloads the explorer folder that lists the new collection or view.
 */

interface DialogBase {
  readonly profileId: string;
  readonly db: string;
  readonly creating: boolean;
  readonly error: string | undefined;
}

export type MongoDialog =
  | (DialogBase & {
      readonly kind: 'create-collection';
      readonly form: CreateCollectionForm;
      /** The server takes clustered collections (5.3+); undefined while asking. */
      readonly clusteredSupported: boolean | undefined;
    })
  | (DialogBase & {
      readonly kind: 'create-view';
      readonly form: CreateViewForm;
      /** Collections and views of the database, for the source picker. */
      readonly sources: readonly string[];
    });

interface DialogsState {
  readonly dialog: MongoDialog | undefined;
}

export const useMongoDialogs = create<DialogsState>()(() => ({ dialog: undefined }));

let lane: SessionLane | undefined;

function setDialog(dialog: MongoDialog | undefined): void {
  useMongoDialogs.setState({ dialog });
}

function current(): MongoDialog | undefined {
  return useMongoDialogs.getState().dialog;
}

function openLane(profileId: string, db: string): SessionLane {
  void lane?.close();
  lane = new SessionLane(profileId, db);
  return lane;
}

/** Opens the create collection dialog for a database. */
export function openCreateCollection(
  profileId: string,
  db: string,
  kind: NewCollectionKind = 'plain',
): void {
  const own = openLane(profileId, db);
  setDialog({
    kind: 'create-collection',
    profileId,
    db,
    form: { ...EMPTY_COLLECTION_FORM, kind },
    clusteredSupported: undefined,
    creating: false,
    error: undefined,
  });
  void own
    .run((host, sessionId) => host.mongo.serverInfo({ sessionId }))
    .then(
      (info) => supportsClustered(info.version),
      () => false,
    )
    .then((clusteredSupported) => {
      const dialog = current();
      if (dialog?.kind === 'create-collection' && lane === own) {
        setDialog({ ...dialog, clusteredSupported });
      }
    });
}

/** Opens the create view dialog for a database, optionally on a source collection. */
export function openCreateView(profileId: string, db: string, source = ''): void {
  const own = openLane(profileId, db);
  setDialog({
    kind: 'create-view',
    profileId,
    db,
    form: { name: '', source, stages: [newStage('$match', '{}')], collation: '' },
    sources: [],
    creating: false,
    error: undefined,
  });
  void own
    .run(async (host, sessionId) => {
      const lists = await Promise.all(
        ['collections', 'views'].map((folder) =>
          host.browse({ sessionId, path: [db, folder] }).catch(() => []),
        ),
      );
      return lists.flat().map((node) => node.name);
    })
    .then((sources) => {
      const dialog = current();
      if (dialog?.kind === 'create-view' && lane === own) setDialog({ ...dialog, sources });
    })
    .catch(() => undefined);
}

export function updateCollectionForm(patch: Partial<CreateCollectionForm>): void {
  const dialog = current();
  if (dialog?.kind === 'create-collection') {
    setDialog({ ...dialog, form: { ...dialog.form, ...patch }, error: undefined });
  }
}

export function updateViewForm(patch: Partial<Omit<CreateViewForm, 'stages'>>): void {
  const dialog = current();
  if (dialog?.kind === 'create-view') {
    setDialog({ ...dialog, form: { ...dialog.form, ...patch }, error: undefined });
  }
}

/** Stage edits of the create view dialog, with the aggregation editor's operations. */
export const viewStages = {
  update(change: (stages: readonly PipelineStage[]) => PipelineStage[]): void {
    const dialog = current();
    if (dialog?.kind !== 'create-view') return;
    setDialog({ ...dialog, form: { ...dialog.form, stages: change(dialog.form.stages) } });
  },
  add(afterIndex: number): void {
    viewStages.update((stages) => insertStage(stages, afterIndex, newStage('$match')));
  },
  remove(id: string): void {
    viewStages.update((stages) => removeStage(stages, id));
  },
  move(from: number, to: number): void {
    viewStages.update((stages) => moveStage(stages, from, to));
  },
  toggle(id: string): void {
    viewStages.update((stages) => toggleStage(stages, id));
  },
  setOperator(id: string, operator: string): void {
    viewStages.update((stages) => setStageOperator(stages, id, operator));
  },
  setBody(id: string, body: string): void {
    viewStages.update((stages) => setStageBody(stages, id, body));
  },
};

export function closeMongoDialog(): void {
  if (current()?.creating) return;
  setDialog(undefined);
  void lane?.close();
  lane = undefined;
}

/** What submitting a dialog runs: its command, and the call that creates the object. */
function planOf(
  dialog: MongoDialog,
): { name: string; command: string; create: Parameters<SessionLane['run']>[0] } | undefined {
  if (dialog.kind === 'create-collection') {
    const built = buildCreateCollection(dialog.db, dialog.form);
    if (!built.ok) return undefined;
    const { name, spec, command } = built.plan;
    return {
      name,
      command,
      create: (host, sessionId) =>
        host.mongo.collections.create({
          sessionId,
          ns: { db: dialog.db, collection: name },
          spec,
          confirmed: true,
        }),
    };
  }
  const built = buildCreateView(dialog.db, dialog.form);
  if (!built.ok) return undefined;
  const { name, spec, command } = built.plan;
  return {
    name,
    command,
    create: (host, sessionId) =>
      host.mongo.collections.createView({
        sessionId,
        ns: { db: dialog.db, collection: name },
        viewOn: spec.viewOn,
        pipeline: spec.pipeline,
        ...(spec.collation !== undefined ? { collation: spec.collation } : {}),
        confirmed: true,
      }),
  };
}

/** Creates the collection or view after the user confirmed its command; true when done. */
export async function submitMongoDialog(): Promise<boolean> {
  const dialog = current();
  const own = lane;
  if (!dialog || dialog.creating || !own) return false;
  const plan = planOf(dialog);
  if (!plan) return false;
  const rules = await loadWriteRules(dialog.profileId);
  if (rules.readOnlyProfile) {
    setDialog({ ...dialog, error: 'This connection is read-only.' });
    return false;
  }
  const what = dialog.kind === 'create-collection' ? 'collection' : 'view';
  const ok = await confirmMongoWrite(rules, {
    title: `Create the ${what} ${dialog.db}.${plan.name}?`,
    command: plan.command,
    always: true,
    confirmLabel: 'Create',
  });
  if (!ok) return false;
  setDialog({ ...dialog, creating: true, error: undefined });
  try {
    await own.run(plan.create);
  } catch (error) {
    const latest = current();
    if (latest) setDialog({ ...latest, creating: false, error: errorMessage(error) });
    return false;
  }
  const folder =
    dialog.kind === 'create-view'
      ? 'views'
      : folderOf(dialog.form.kind === 'timeseries' ? 'timeseries' : 'collection');
  setDialog(undefined);
  void own.close();
  if (lane === own) lane = undefined;
  await loadChildren(dialog.profileId, [dialog.db, folder]).catch(() => undefined);
  return true;
}
