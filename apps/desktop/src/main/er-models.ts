import { erModelDocumentSchema, type HandlersOf, type mainContract } from '@querybara/ipc';
import type { Store } from '@querybara/storage';

/**
 * The main contract's ER model drafts (spec §8): unapplied model changes kept in the local
 * store per connection, database and schema. A stored model this build cannot read (written by
 * a newer Querybara) is reported as no draft rather than failing the diagram, and is left in
 * place.
 */

type MainHandlers = HandlersOf<typeof mainContract>;

export function erModelHandlers(store: Store): MainHandlers['erModels'] {
  const drafts = store.erModelDrafts;
  return {
    listDrafts: ({ profileId, database }) =>
      drafts.list(database === undefined ? { profileId } : { profileId, database }),
    getDraft: (key) => {
      const draft = drafts.get(key);
      if (!draft) return null;
      const document = erModelDocumentSchema.safeParse(draft.document);
      return document.success ? { ...draft, document: document.data } : null;
    },
    putDraft: ({ document, ...rest }) => {
      const { document: _stored, ...summary } = drafts.put({ ...rest, document });
      return summary;
    },
    deleteDraft: (key) => ({ deleted: drafts.delete(key) }),
  };
}
