import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useId, useMemo, useState } from 'react';

import iconUrl from '../../../../build/icon.svg';
import {
  THIRD_PARTY_REPORT,
  thirdPartyReportSchema,
  type ThirdPartyPackage,
} from '../../../shared/third-party';
import { errorMessage } from '../lib/errors';
import { mainApi } from '../lib/main-client';
import {
  checkForUpdates,
  openAbout,
  restartToUpdate,
  setUpdatePreferences,
  statusText,
  useUpdates,
} from '../state/updates';
import { Button, Field, Input, Modal, Select, TAB } from './ui';

/**
 * The About box (spec §20): version and runtime, the update preferences (channel, automatic
 * checks, check now, restart into a downloaded update, release notes) and the third-party
 * licences the build shipped. The menu's About item and the header button open it.
 */
export function AboutDialog() {
  const open = useUpdates((state) => state.aboutOpen);
  return open ? <About /> : null;
}

function About() {
  const info = useQuery({ queryKey: ['app', 'info'], queryFn: () => mainApi().app.info() });
  const [tab, setTab] = useState<'updates' | 'licences'>('updates');
  const versions = info.data?.versions;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) openAbout(false);
      }}
      title="About Joinery"
      width="w-[640px]"
      footer={
        <Button variant="primary" onClick={() => openAbout(false)}>
          Close
        </Button>
      }
    >
      <div className="flex items-center gap-4">
        <img src={iconUrl} alt="" className="h-14 w-14 shrink-0" draggable={false} />
        <div className="min-w-0">
          <p className="text-base font-semibold">Joinery</p>
          <p className="text-[13px]" data-testid="about-version">
            Version {info.data?.version ?? '…'}
          </p>
          {versions && info.data && (
            <p className="text-xs text-muted select-text">
              Electron {versions.electron} · Chromium {versions.chrome} · Node.js {versions.node} ·{' '}
              {info.data.platform} {info.data.arch}
            </p>
          )}
        </div>
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(value as 'updates' | 'licences')}
        className="mt-4 flex min-h-0 flex-col"
      >
        <Tabs.List aria-label="About sections" className="flex gap-0.5 border-b border-border">
          {(['updates', 'licences'] as const).map((value) => (
            <Tabs.Trigger key={value} value={value} className={TAB}>
              {value === 'updates' ? 'Updates' : 'Third-party licences'}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="updates" className="pt-3">
          <UpdatesSection />
        </Tabs.Content>
        <Tabs.Content value="licences" className="pt-3">
          <LicencesSection />
        </Tabs.Content>
      </Tabs.Root>
    </Modal>
  );
}

function UpdatesSection() {
  const status = useUpdates((state) => state.status);
  const channelId = useId();
  const [error, setError] = useState<string>();
  if (!status) return <p className="text-[13px] text-muted">Reading the update status…</p>;
  const { state, managed } = status;
  const off = state.state === 'off';
  const busy = state.state === 'checking' || state.state === 'downloading';
  const run = (action: () => Promise<void>): void => {
    setError(undefined);
    action().catch((failure: unknown) => setError(errorMessage(failure)));
  };
  return (
    <div className="flex flex-col gap-3">
      <p role="status" data-testid="update-status" className="text-[13px]">
        {statusText(status)}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Update channel"
          htmlFor={channelId}
          hint={
            managed.channel
              ? 'Set by your administrator.'
              : 'Beta gets new versions first; stable gets them once they have settled.'
          }
        >
          <Select
            id={channelId}
            value={status.channel}
            disabled={managed.channel || managed.disabled}
            onChange={(event) =>
              run(() =>
                setUpdatePreferences({ updateChannel: event.target.value as 'stable' | 'beta' }),
              )
            }
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 self-start pt-6 text-[13px]">
          <input
            type="checkbox"
            checked={status.autoCheck}
            disabled={managed.disabled}
            onChange={(event) =>
              run(() => setUpdatePreferences({ updateAutoCheck: event.target.checked }))
            }
          />
          Check for updates automatically
        </label>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state.state === 'ready' ? (
          <Button variant="primary" onClick={() => run(restartToUpdate)}>
            Restart to update
          </Button>
        ) : (
          <Button disabled={off || busy} onClick={() => run(checkForUpdates)}>
            Check for updates
          </Button>
        )}
        {status.releaseNotesUrl !== undefined && (
          <Button
            variant="ghost"
            onClick={() =>
              run(() => mainApi().app.openExternal({ url: status.releaseNotesUrl ?? '' }))
            }
          >
            Release notes
          </Button>
        )}
        {status.lastCheckedAt !== undefined && (
          <span className="text-xs text-muted">
            Last checked {new Date(status.lastCheckedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

async function loadReport(): Promise<ThirdPartyPackage[] | null> {
  const response = await fetch(new URL(THIRD_PARTY_REPORT, document.baseURI));
  // Development runs serve the renderer from Vite, which has no report.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The licence report could not be read (${response.status})`);
  return thirdPartyReportSchema.parse(await response.json()).packages;
}

function LicencesSection() {
  const report = useQuery({ queryKey: ['third-party'], queryFn: loadReport, staleTime: Infinity });
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (report.data ?? []).filter(
      (p) =>
        needle === '' ||
        p.name.toLowerCase().includes(needle) ||
        p.licence.toLowerCase().includes(needle),
    );
  }, [report.data, filter]);

  if (report.isPending) return <p className="text-[13px] text-muted">Reading the licences…</p>;
  if (report.isError) {
    return (
      <p role="alert" className="text-[13px] text-danger">
        {errorMessage(report.error)}
      </p>
    );
  }
  if (report.data === null) {
    return (
      <p className="text-[13px] text-muted">
        The licence report is written by production builds (electron-vite build).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Joinery includes the {report.data.length} open-source packages below, each under its own
        licence. The Electron runtime carries the licences of Chromium and Node.js in
        LICENSES.chromium.html next to the application.
      </p>
      <Field label="Filter packages" htmlFor={filterId}>
        <Input
          id={filterId}
          value={filter}
          placeholder="Name or licence"
          onChange={(event) => setFilter(event.target.value)}
        />
      </Field>
      <ul
        aria-label="Third-party packages"
        className="max-h-72 overflow-auto rounded border border-border"
      >
        {shown.map((p) => (
          <li key={`${p.name}@${p.version}`} className="border-b border-border last:border-b-0">
            <details>
              <summary className="cursor-pointer px-2 py-1 text-[13px]">
                <span className="font-medium">{p.name}</span>{' '}
                <span className="text-muted">
                  {p.version} · {p.licence}
                </span>
              </summary>
              <div className="flex flex-col gap-1 px-2 pb-2">
                {p.homepage !== undefined && (
                  <span className="text-xs text-muted select-text">{p.homepage}</span>
                )}
                <pre className="max-h-48 overflow-auto rounded bg-panel-2 p-2 text-[11px] whitespace-pre-wrap select-text">
                  {p.licenceText ?? `No licence file in the package; licensed under ${p.licence}.`}
                  {p.noticeText !== undefined && `\n\n${p.noticeText}`}
                </pre>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
