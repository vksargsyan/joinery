import { ENGINES } from '@joinery/core';
import type { SavedComparison } from '@joinery/ipc';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { useState, type ReactElement } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { useProfiles } from '../../state/data';
import { confirm } from '../../state/dialogs';
import {
  openDataCompare,
  openSavedComparison,
  openStructureCompare,
  showSavedComparisons,
  useSyncPanels,
} from '../../state/sync/panels';
import { Button, Modal } from '../ui';
import { comparisonDraft, editSchedule } from '../../state/schedules';

/**
 * The window's Compare menu (spec §13): a new structure or data compare, and the saved
 * comparisons, which reopen in a panel of their own.
 */

export const SAVED_COMPARISONS_KEY = ['sync', 'saved'] as const;

/** `trigger` is the button that opens the menu (the title bar's Compare icon). */
export function SyncMenu(props: { readonly trigger: ReactElement }) {
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>{props.trigger}</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 min-w-48 rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
          >
            <Item onSelect={() => openStructureCompare()}>Compare structure…</Item>
            <Item onSelect={() => openDataCompare()}>Compare data…</Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <Item onSelect={() => showSavedComparisons(true)}>Saved comparisons…</Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <SavedComparisonsHost />
    </>
  );
}

function Item(props: { readonly children: string; readonly onSelect: () => void }) {
  return (
    <DropdownMenu.Item
      onSelect={props.onSelect}
      className="cursor-default rounded px-2 py-1.5 outline-none data-[highlighted]:bg-list-active"
    >
      {props.children}
    </DropdownMenu.Item>
  );
}

function SavedComparisonsHost() {
  const open = useSyncPanels((state) => state.savedOpen);
  return open ? <SavedComparisonsDialog onClose={() => showSavedComparisons(false)} /> : null;
}

/** The saved comparisons: open one, or delete it. */
export function SavedComparisonsDialog(props: { readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const profiles = useProfiles();
  const saved = useQuery({
    queryKey: SAVED_COMPARISONS_KEY,
    queryFn: () => mainApi().sync.saved.list(),
    staleTime: 0,
  });
  const [error, setError] = useState<string>();
  const nameOf = (profileId: string | null): string => {
    if (profileId === null) return '(deleted connection)';
    const profile = profiles.data?.find((p) => p.id === profileId);
    return profile ? `${profile.name} · ${ENGINES[profile.engine].displayName}` : '…';
  };
  const remove = async (comparison: SavedComparison): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${comparison.name}"?`,
      message: 'The saved comparison is deleted; the databases are not touched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await mainApi().sync.saved.delete({ id: comparison.id });
      await queryClient.invalidateQueries({ queryKey: SAVED_COMPARISONS_KEY });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const side = (s: SavedComparison['source']): string =>
    `${nameOf(s.profileId)}${s.database ? ` (${s.database})` : ''}${s.schemas?.length ? ` [${s.schemas.join(', ')}]` : ''}`;
  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && props.onClose()}
      title="Saved comparisons"
      width="w-[720px]"
      footer={
        <Button variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      )}
      {saved.isLoading && <p className="text-xs text-muted">Loading…</p>}
      {saved.error && <p className="text-xs text-danger">{errorMessage(saved.error)}</p>}
      {saved.data?.length === 0 && (
        <p className="text-xs text-muted">
          No saved comparisons yet. Save one from a compare panel with “Save comparison…”.
        </p>
      )}
      <ul className="flex flex-col gap-1" aria-label="Saved comparisons">
        {saved.data?.map((comparison) => (
          <li
            key={comparison.id}
            className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs"
            data-testid="saved-comparison"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {comparison.name}
                <span className="ml-1.5 rounded bg-panel-2 px-1 text-[10px] text-muted uppercase">
                  {comparison.kind}
                </span>
              </p>
              <p className="truncate text-[11px] text-muted">
                {side(comparison.source)} → {side(comparison.target)}
              </p>
            </div>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                openSavedComparison(comparison);
                props.onClose();
              }}
            >
              Open
            </Button>
            <Button
              size="sm"
              onClick={() => {
                editSchedule(comparisonDraft(comparison));
                props.onClose();
              }}
              disabled={
                comparison.source.profileId === null || comparison.target.profileId === null
              }
              title="Run this comparison on a schedule and keep a report when it finds differences"
            >
              Schedule…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void remove(comparison)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
