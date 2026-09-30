import { DropdownMenu } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import { confirm } from '../../state/dialogs';
import { useTableState, type TableView } from '../../state/table-view';
import { Button, Field, Icon, Input, Modal } from '../ui';

/**
 * The saved views of a table (spec §7, "save views per table"): the picker applies the plain
 * table ("Default") or a named view (its columns, sort and filter), saves the current state as
 * a new view or into the applied one, picks the view the table opens with, deletes a view, and
 * resets the grid to the applied view.
 */
export function ViewPicker({ view }: { readonly view: TableView }) {
  const views = useTableState(view, (s) => s.views);
  const activeId = useTableState(view, (s) => s.activeViewId);
  // The indicator follows every change of what a view keeps.
  useTableState(view, (s) => s.layout);
  useTableState(view, (s) => s.sort);
  useTableState(view, (s) => s.draft);
  useTableState(view, (s) => s.rawText);
  useTableState(view, (s) => s.filterMode);
  const [saving, setSaving] = useState(false);
  const active = views.find((v) => v.id === activeId);
  const modified = view.viewModified();

  const run = (action: () => Promise<void>): void => {
    void action().catch((error: unknown) =>
      view.store.setState({ notice: { kind: 'error', text: errorMessage(error) } }),
    );
  };

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            size="sm"
            variant="ghost"
            data-testid="view-picker"
            title="Saved views of this table: columns, sort and filter"
          >
            View: {active?.name ?? 'Default'}
            {modified && (
              <span className="text-warning" aria-label="modified">
                *
              </span>
            )}
            <Icon name="chevron-down" className="h-3 w-3" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            aria-label="Views"
            className="z-50 max-h-[70vh] min-w-60 overflow-auto rounded border border-border bg-panel p-1 text-[13px] shadow-xl"
          >
            <DropdownMenu.RadioGroup
              value={activeId ?? ''}
              onValueChange={(id) => run(() => view.applyView(id === '' ? null : id))}
            >
              <Radio value="">Default</Radio>
              {views.map((saved) => (
                <Radio key={saved.id} value={saved.id}>
                  {saved.name}
                  {saved.isDefault && (
                    <span className="ml-1 text-[11px] text-muted">(opens by default)</span>
                  )}
                </Radio>
              ))}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <Item onSelect={() => setSaving(true)}>Save view as…</Item>
            {active && (
              <>
                <Item disabled={!modified} onSelect={() => run(() => view.updateView(active.id))}>
                  Save changes to “{active.name}”
                </Item>
                <Item
                  onSelect={() =>
                    run(() => view.setDefaultView(active.isDefault ? null : active.id))
                  }
                >
                  {active.isDefault
                    ? `Stop opening with “${active.name}”`
                    : `Open the table with “${active.name}”`}
                </Item>
                <Item
                  danger
                  onSelect={() =>
                    run(async () => {
                      const ok = await confirm({
                        title: `Delete the view “${active.name}”?`,
                        message: 'The grid keeps showing what it shows now.',
                        confirmLabel: 'Delete view',
                        danger: true,
                      });
                      if (ok) await view.deleteView(active.id);
                    })
                  }
                >
                  Delete “{active.name}”…
                </Item>
              </>
            )}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <Item disabled={!modified} onSelect={() => run(() => view.applyView(activeId ?? null))}>
              Reset {active ? `to “${active.name}”` : 'to the default view'}
            </Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {saving && <SaveViewDialog view={view} onClose={() => setSaving(false)} />}
    </>
  );
}

function SaveViewDialog(props: { readonly view: TableView; readonly onClose: () => void }) {
  const { view } = props;
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Name the view');
      return;
    }
    setBusy(true);
    try {
      await view.saveViewAs(trimmed, { makeDefault });
      props.onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Save view"
      description="Keeps the columns (order, visibility, pins and widths), the sort and the filter of this table."
      width="w-[420px]"
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save view
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="save-view-name" error={error}>
          <Input
            id="save-view-name"
            autoFocus
            value={name}
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
          />
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(event) => setMakeDefault(event.target.checked)}
          />
          Open the table with this view
        </label>
      </form>
    </Modal>
  );
}

function Radio(props: { readonly value: string; readonly children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={props.value}
      className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-hover"
    >
      <span className="w-3 text-accent">
        <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
      </span>
      <span className="truncate">{props.children}</span>
    </DropdownMenu.RadioItem>
  );
}

function Item(props: {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={props.disabled}
      onSelect={props.onSelect}
      className={
        'cursor-default rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover' +
        (props.danger ? ' text-danger' : '')
      }
    >
      {props.children}
    </DropdownMenu.Item>
  );
}
