import type { GeoMember, HashEntry, ZSetEntry } from '@joinery/driver-redis';
import { bytesKey, displayBytes, parseDisplayBytes } from '@joinery/redis-tools';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import {
  EditError,
  addHashField,
  addZSetEntry,
  editHashField,
  editListItem,
  editSetMember,
  editZSetEntry,
  type ValueEdit,
} from '../../../state/redis/value-model';
import { Button, Input, cx } from '../../ui';
import { Notice, Toolbar } from '../common';
import { useValueEditor } from '../ValueEditorPanel';
import { EditGrid, type GridRow } from './EditGrid';

/**
 * Hash, list, set and sorted-set editors (spec §10): pages of HSCAN / LRANGE / SSCAN / ZRANGE
 * with "Load more", inline edit, add and remove, and score editing. A sorted set can also be
 * shown as geo members with their coordinates.
 */

const PAGE = 200;

/** Paged loading shared by the editors: items, whether more exist, and errors. */
function usePages<T, C>(
  load: (
    cursor: C | undefined,
  ) => Promise<{ readonly items: readonly T[]; readonly next: C | undefined }>,
  deps: readonly unknown[],
) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<C | undefined>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const fetchPage = useCallback(
    async (reset: boolean): Promise<void> => {
      setLoading(true);
      try {
        const page = await load(reset ? undefined : next);
        setItems((current) => (reset ? [...page.items] : [...current, ...page.items]));
        setNext(page.next);
        setMore(page.next !== undefined);
        setError(undefined);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    // `load` closes over the caller's inputs, listed in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [next, ...deps],
  );
  useEffect(() => {
    void fetchPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { items, setItems, more, loading, error, setError, fetchPage };
}

function PagingBar(props: {
  readonly loaded: number;
  readonly noun: string;
  readonly more: boolean;
  readonly loading: boolean;
  readonly onMore: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <Toolbar label="Value">
      {props.children}
      <span className="flex-1" />
      <span className="text-xs text-muted" data-testid="loaded-count">
        {formatCount(props.loaded)} {props.noun} loaded
        {props.loading ? ' · loading…' : props.more ? '' : ' · all'}
      </span>
      {props.more && (
        <Button size="sm" onClick={props.onMore} disabled={props.loading}>
          Load more
        </Button>
      )}
    </Toolbar>
  );
}

// ---------------------------------------------------------------------------------------------

export function HashEditor() {
  const editor = useValueEditor();
  const [match, setMatch] = useState('');
  const [applied, setApplied] = useState('');
  const pages = usePages<HashEntry, string>(
    async (cursor) => {
      const page = await editor.run((host, sessionId) =>
        host.redis.hash.scan({
          sessionId,
          key: editor.key,
          options: {
            count: PAGE,
            ...(cursor !== undefined ? { cursor } : {}),
            ...(applied !== '' ? { match: parseDisplayBytes(applied) } : {}),
          },
        }),
      );
      return { items: page.items, next: page.done ? undefined : page.cursor };
    },
    [bytesKey(editor.key), applied],
  );
  const loaded = new Set(pages.items.map((e) => bytesKey(e.field)));
  const fieldExists = async (field: Uint8Array): Promise<boolean> => {
    if (loaded.has(bytesKey(field))) return true;
    const [value] = await editor.run((host, sessionId) =>
      host.redis.hash.get({ sessionId, key: editor.key, fields: [field] }),
    );
    return value !== null && value !== undefined;
  };
  const rows: GridRow[] = pages.items.map((e) => ({
    id: bytesKey(e.field),
    cells: [displayBytes(e.field), displayBytes(e.value)],
  }));
  const entryOf = (row: GridRow): HashEntry =>
    pages.items.find((e) => bytesKey(e.field) === row.id)!;

  return (
    <div className="flex h-full flex-col" data-testid="hash-editor">
      <PagingBar
        loaded={pages.items.length}
        noun="fields"
        more={pages.more}
        loading={pages.loading}
        onMore={() => void pages.fetchPage(false)}
      >
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(match);
          }}
        >
          <Input
            aria-label="Field pattern"
            placeholder="Field pattern (HSCAN MATCH)"
            className="h-7 w-56 font-mono text-xs"
            value={match}
            onChange={(e) => setMatch(e.target.value)}
          />
          <Button size="sm" type="submit">
            Filter
          </Button>
        </form>
      </PagingBar>
      {pages.error && <Notice kind="error">{pages.error}</Notice>}
      <div className="min-h-0 flex-1">
        <EditGrid
          label="Hash fields"
          columns={[
            { label: 'Field', editable: true },
            { label: 'Value', editable: true },
          ]}
          rows={rows}
          addLabel="Add field"
          onSave={async (row, [field = '', value = '']) => {
            const entry = entryOf(row);
            const newField = parseDisplayBytes(field);
            const renamed = bytesKey(newField) !== row.id;
            if (renamed && (await fieldExists(newField))) {
              throw new EditError(`The field "${field}" already exists`);
            }
            const edits = editHashField(entry.field, entry.value, { field, value }, () => false);
            if (!(await editor.apply(edits))) return;
            pages.setItems((items) =>
              items.map((e) =>
                bytesKey(e.field) === row.id
                  ? { field: newField, value: parseDisplayBytes(value) }
                  : e,
              ),
            );
          }}
          onRemove={async (row) => {
            const entry = entryOf(row);
            const edits: ValueEdit[] = [{ op: 'hdel', fields: [entry.field] }];
            if (!(await editor.apply(edits, { removal: 'removes the field' }))) return;
            pages.setItems((items) => items.filter((e) => bytesKey(e.field) !== row.id));
          }}
          onAdd={async ([field = '', value = '']) => {
            const bytes = parseDisplayBytes(field);
            if (await fieldExists(bytes))
              throw new EditError(`The field "${field}" already exists`);
            if (!(await editor.apply(addHashField({ field, value }, () => false)))) return;
            pages.setItems((items) => [
              { field: bytes, value: parseDisplayBytes(value) },
              ...items,
            ]);
          }}
          empty={applied ? 'No fields match.' : 'The hash has no fields.'}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ListEditor() {
  const editor = useValueEditor();
  const [version, setVersion] = useState(0);
  const pages = usePages<Uint8Array, number>(
    async (start = 0) => {
      const items = await editor.run((host, sessionId) =>
        host.redis.list.range({ sessionId, key: editor.key, start, stop: start + PAGE - 1 }),
      );
      return { items, next: items.length === PAGE ? start + PAGE : undefined };
    },
    [bytesKey(editor.key), version],
  );
  const rows: GridRow[] = pages.items.map((value, index) => ({
    id: String(index),
    cells: [String(index), displayBytes(value)],
  }));
  const push = async (side: 'left' | 'right', value: string): Promise<void> => {
    const edits: ValueEdit[] = [{ op: 'push', side, values: [parseDisplayBytes(value)] }];
    if (await editor.apply(edits)) setVersion((v) => v + 1);
  };
  return (
    <div className="flex h-full flex-col" data-testid="list-editor">
      <PagingBar
        loaded={pages.items.length}
        noun="elements"
        more={pages.more}
        loading={pages.loading}
        onMore={() => void pages.fetchPage(false)}
      />
      {pages.error && <Notice kind="error">{pages.error}</Notice>}
      <div className="min-h-0 flex-1">
        <EditGrid
          label="List elements"
          columns={[
            { label: 'Index', width: 'w-16' },
            { label: 'Element', editable: true },
          ]}
          rows={rows}
          addLabel="Push element"
          addActions={(values, reset) => (
            <>
              <Button
                size="sm"
                onClick={() => void push('left', values[1] ?? '').then(reset)}
                title="LPUSH: add at the head"
              >
                Head
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void push('right', values[1] ?? '').then(reset)}
                title="RPUSH: add at the tail"
              >
                Tail
              </Button>
            </>
          )}
          onSave={async (row, values) => {
            const index = Number(row.id);
            const edits = editListItem(index, pages.items[index]!, values[1] ?? '');
            if (!(await editor.apply(edits))) return;
            pages.setItems((items) =>
              items.map((item, i) => (i === index ? parseDisplayBytes(values[1] ?? '') : item)),
            );
          }}
          onRemove={async (row) => {
            const index = Number(row.id);
            const edits: ValueEdit[] = [{ op: 'lrem-at', index, expected: pages.items[index]! }];
            if (await editor.apply(edits, { removal: 'removes the element' })) {
              setVersion((v) => v + 1);
            }
          }}
          empty="The list is empty."
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function SetEditor() {
  const editor = useValueEditor();
  const [match, setMatch] = useState('');
  const [applied, setApplied] = useState('');
  const pages = usePages<Uint8Array, string>(
    async (cursor) => {
      const page = await editor.run((host, sessionId) =>
        host.redis.set.scan({
          sessionId,
          key: editor.key,
          options: {
            count: PAGE,
            ...(cursor !== undefined ? { cursor } : {}),
            ...(applied !== '' ? { match: parseDisplayBytes(applied) } : {}),
          },
        }),
      );
      return { items: page.items, next: page.done ? undefined : page.cursor };
    },
    [bytesKey(editor.key), applied],
  );
  const loaded = new Set(pages.items.map(bytesKey));
  const rows: GridRow[] = pages.items.map((m) => ({ id: bytesKey(m), cells: [displayBytes(m)] }));
  const memberOf = (row: GridRow): Uint8Array => pages.items.find((m) => bytesKey(m) === row.id)!;
  return (
    <div className="flex h-full flex-col" data-testid="set-editor">
      <PagingBar
        loaded={pages.items.length}
        noun="members"
        more={pages.more}
        loading={pages.loading}
        onMore={() => void pages.fetchPage(false)}
      >
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(match);
          }}
        >
          <Input
            aria-label="Member pattern"
            placeholder="Member pattern (SSCAN MATCH)"
            className="h-7 w-56 font-mono text-xs"
            value={match}
            onChange={(e) => setMatch(e.target.value)}
          />
          <Button size="sm" type="submit">
            Filter
          </Button>
        </form>
      </PagingBar>
      {pages.error && <Notice kind="error">{pages.error}</Notice>}
      <div className="min-h-0 flex-1">
        <EditGrid
          label="Set members"
          columns={[{ label: 'Member', editable: true }]}
          rows={rows}
          addLabel="Add member"
          onSave={async (row, [value = '']) => {
            const edits = editSetMember(memberOf(row), value, (m) => loaded.has(bytesKey(m)));
            if (!(await editor.apply(edits))) return;
            pages.setItems((items) =>
              items.map((m) => (bytesKey(m) === row.id ? parseDisplayBytes(value) : m)),
            );
          }}
          onRemove={async (row) => {
            const edits: ValueEdit[] = [{ op: 'srem', members: [memberOf(row)] }];
            if (!(await editor.apply(edits, { removal: 'removes the member' }))) return;
            pages.setItems((items) => items.filter((m) => bytesKey(m) !== row.id));
          }}
          onAdd={async ([value = '']) => {
            const member = parseDisplayBytes(value);
            if (loaded.has(bytesKey(member))) throw new EditError(`"${value}" is already a member`);
            if (!(await editor.apply([{ op: 'sadd', members: [member] }]))) return;
            pages.setItems((items) => [member, ...items]);
          }}
          empty={applied ? 'No members match.' : 'The set is empty.'}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ZSetEditor() {
  const editor = useValueEditor();
  const [reverse, setReverse] = useState(false);
  const [geo, setGeo] = useState(false);
  const [version, setVersion] = useState(0);
  const pages = usePages<ZSetEntry, number>(
    async (start = 0) => {
      const items = await editor.run((host, sessionId) =>
        host.redis.zset.range({
          sessionId,
          key: editor.key,
          options: { by: 'index', start, stop: start + PAGE - 1, reverse },
        }),
      );
      return { items, next: items.length === PAGE ? start + PAGE : undefined };
    },
    [bytesKey(editor.key), reverse, version],
  );
  const loaded = new Set(pages.items.map((e) => bytesKey(e.member)));
  const rows: GridRow[] = pages.items.map((e) => ({
    id: bytesKey(e.member),
    cells: [displayBytes(e.member), e.scoreText],
  }));
  const entryOf = (row: GridRow): ZSetEntry =>
    pages.items.find((e) => bytesKey(e.member) === row.id)!;
  return (
    <div className="flex h-full flex-col" data-testid="zset-editor">
      <PagingBar
        loaded={pages.items.length}
        noun="members"
        more={pages.more}
        loading={pages.loading}
        onMore={() => void pages.fetchPage(false)}
      >
        <div className="flex rounded border border-border" role="radiogroup" aria-label="Order">
          {[false, true].map((desc) => (
            <button
              key={String(desc)}
              type="button"
              role="radio"
              aria-checked={reverse === desc}
              className={cx(
                'h-7 px-2 text-xs',
                reverse === desc ? 'bg-badge text-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setReverse(desc)}
            >
              {desc ? 'Highest first' : 'Lowest first'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={geo} onChange={(e) => setGeo(e.target.checked)} />
          Geo view
        </label>
      </PagingBar>
      {pages.error && <Notice kind="error">{pages.error}</Notice>}
      <div className="min-h-0 flex-1">
        {geo ? (
          <GeoView count={Math.max(PAGE, pages.items.length)} version={version} />
        ) : (
          <EditGrid
            label="Sorted set members"
            columns={[
              { label: 'Member', editable: true },
              { label: 'Score', editable: true, width: 'w-40', align: 'right' },
            ]}
            rows={rows}
            addLabel="Add member"
            onSave={async (row, [member = '', score = '']) => {
              const entry = entryOf(row);
              const edits = editZSetEntry(entry.member, entry.scoreText, { member, score }, (m) =>
                loaded.has(bytesKey(m)),
              );
              if (await editor.apply(edits)) setVersion((v) => v + 1);
            }}
            onRemove={async (row) => {
              const edits: ValueEdit[] = [{ op: 'zrem', members: [entryOf(row).member] }];
              if (!(await editor.apply(edits, { removal: 'removes the member' }))) return;
              pages.setItems((items) => items.filter((e) => bytesKey(e.member) !== row.id));
            }}
            onAdd={async ([member = '', score = '']) => {
              const edits = addZSetEntry({ member, score }, (m) => loaded.has(bytesKey(m)));
              if (await editor.apply(edits)) setVersion((v) => v + 1);
            }}
            empty="The sorted set is empty."
          />
        )}
      </div>
    </div>
  );
}

function GeoView(props: { readonly count: number; readonly version: number }) {
  const editor = useValueEditor();
  const [members, setMembers] = useState<GeoMember[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    editor
      .run((host, sessionId) =>
        host.redis.geo.members({ sessionId, key: editor.key, start: 0, stop: props.count - 1 }),
      )
      .then(
        (loaded) => live && setMembers(loaded),
        (e: unknown) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.count, props.version, bytesKey(editor.key)]);
  if (error) return <Notice kind="error">{error}</Notice>;
  return (
    <EditGrid
      label="Geo members"
      columns={[
        { label: 'Member' },
        { label: 'Longitude', width: 'w-32', align: 'right' },
        { label: 'Latitude', width: 'w-32', align: 'right' },
      ]}
      rows={(members ?? []).map((m) => ({
        id: bytesKey(m.member),
        cells: [displayBytes(m.member), m.longitude.toFixed(6), m.latitude.toFixed(6)],
      }))}
      empty={members ? 'No members.' : 'Loading…'}
    />
  );
}
