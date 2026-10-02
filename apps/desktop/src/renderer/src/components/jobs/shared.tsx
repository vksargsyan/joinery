import type {
  ExportSettings,
  ImportSettings,
  TransferPreview,
  TransferProfile,
} from '@joinery/ipc';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { Button, cx } from '../ui';
import { SelectField, TextField } from '../designer/fields';

/** Pieces the transfer wizards share: the step bar, saved settings and the preview table. */

export function StepBar<S extends string>(props: {
  readonly steps: readonly S[];
  readonly labels: Readonly<Record<S, string>>;
  readonly current: S;
}) {
  const at = props.steps.indexOf(props.current);
  return (
    <ol className="mb-3 flex items-center gap-1 text-[11px]" aria-label="Steps">
      {props.steps.map((step, index) => (
        <li
          key={step}
          aria-current={step === props.current ? 'step' : undefined}
          className={cx(
            'flex items-center gap-1 rounded px-2 py-0.5',
            step === props.current
              ? 'bg-badge text-rust'
              : index < at
                ? 'bg-panel-2 text-fg'
                : 'text-muted',
          )}
        >
          <span className="font-semibold">{index + 1}</span>
          {props.labels[step]}
        </li>
      ))}
    </ol>
  );
}

const PROFILES_KEY = ['transfer-profiles'] as const;

/**
 * Saved wizard settings (spec §12: every wizard can save its settings as a profile): load one
 * into the wizard, or save the current options under a name. File paths are never saved.
 */
export function SavedSettings<K extends 'import' | 'export'>(props: {
  readonly kind: K;
  readonly current: () => K extends 'import' ? ImportSettings : ExportSettings;
  readonly onLoad: (settings: K extends 'import' ? ImportSettings : ExportSettings) => void;
}) {
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: () => mainApi().transfer.profiles.list(),
  });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string>();
  const mine = (profiles.data ?? []).filter(
    (profile): profile is Extract<TransferProfile, { kind: K }> => profile.kind === props.kind,
  );
  const save = async (): Promise<void> => {
    if (name.trim() === '') return;
    try {
      const settings = props.current();
      await mainApi().transfer.profiles.save(
        props.kind === 'import'
          ? { kind: 'import', name: name.trim(), settings: settings as ImportSettings }
          : { kind: 'export', name: name.trim(), settings: settings as ExportSettings },
      );
      await queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
      setNaming(false);
      setNote(`Saved "${name.trim()}"`);
    } catch (error) {
      setNote(errorMessage(error));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={`saved-${props.kind}`} className="text-muted">
        Saved settings
      </label>
      <div className="w-56">
        <SelectField
          id={`saved-${props.kind}`}
          value=""
          onChange={(event) => {
            const profile = mine.find((p) => p.id === event.target.value);
            if (profile) {
              props.onLoad(profile.settings as Parameters<typeof props.onLoad>[0]);
              setNote(`Loaded "${profile.name}"`);
            }
          }}
        >
          <option value="">{mine.length === 0 ? 'None saved yet' : 'Load…'}</option>
          {mine.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </SelectField>
      </div>
      {naming ? (
        <>
          <div className="w-40">
            <TextField
              aria-label="Settings name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save();
                if (event.key === 'Escape') setNaming(false);
              }}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={name.trim() === ''}>
            Save
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
          Save settings…
        </Button>
      )}
      {note && <span className="text-muted">{note}</span>}
    </div>
  );
}

/** The sample rows of a preview, with each column's inferred type under its name. */
export function PreviewTable(props: { readonly preview: TransferPreview; readonly rows?: number }) {
  const { preview } = props;
  const rows = preview.rows.slice(0, props.rows ?? 50);
  return (
    <div
      className="max-h-72 overflow-auto rounded border border-border"
      data-testid="import-preview"
    >
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-panel text-left">
          <tr>
            {preview.columns.map((column) => (
              <th key={column.name} className="px-1.5 py-1 align-bottom font-medium">
                <span className="block truncate">{column.name}</span>
                <span className="block font-normal text-muted">{column.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-border/60">
              {preview.columns.map((column, c) => {
                const value = row[c] ?? null;
                return (
                  <td
                    key={column.name}
                    className={cx(
                      'max-w-60 truncate px-1.5 py-0.5',
                      value === null && 'text-muted',
                    )}
                  >
                    {value === null ? 'NULL' : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
