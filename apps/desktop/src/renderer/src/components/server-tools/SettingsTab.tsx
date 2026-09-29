import type { ActionResult, ServerSetting, SettingScope } from '@joinery/core';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { filterSettings } from '../../state/server-tools/view';
import { Notice, Toolbar } from '../redis/common';
import { Button, Field, Input, Modal, Select } from '../ui';
import { ActionOutcome, Check, NoticeList, runAction, useToolData, type TabProps } from './common';

/**
 * Settings (spec §15): pg_settings, system variables or server parameters with their source,
 * unit, limits and whether a change needs a restart; a change picks where it applies (SET,
 * ALTER DATABASE, ALTER SYSTEM; SET GLOBAL or PERSIST; setParameter) and shows the statement
 * before it runs.
 */

export function SettingsTab({ panelId, info }: TabProps) {
  const [text, setText] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [editing, setEditing] = useState<ServerSetting>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();
  const list = useToolData(
    panelId,
    undefined,
    (host, sessionId) => host.serverTools.settings({ sessionId }),
    [],
  );
  const settings = filterSettings(list.data?.settings ?? [], { text, changedOnly });
  const shown = settings.slice(0, 1000);

  const apply = async (
    setting: ServerSetting,
    value: string | null,
    scope: SettingScope,
  ): Promise<void> => {
    setEditing(undefined);
    setError(undefined);
    try {
      const done = await runAction(
        panelId,
        { kind: 'setting', name: setting.name, value, scope },
        { confirmLabel: value === null ? 'Reset' : 'Apply' },
      );
      if (done) {
        setResult(done);
        await list.reload();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="server-settings">
      <Toolbar label="Settings">
        <Input
          aria-label="Filter settings"
          placeholder="Filter by name, description or category"
          className="h-7 w-72 text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Check label="Changed from default" checked={changedOnly} onChange={setChangedOnly} />
        <Button size="sm" onClick={() => void list.reload()} disabled={list.loading}>
          Refresh
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted">
          {settings.length} of {list.data?.settings.length ?? 0}
        </span>
      </Toolbar>
      {(error ?? list.error) && <Notice kind="error">{error ?? list.error}</Notice>}
      <NoticeList notices={list.data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs" aria-label="Settings" data-testid="settings-table">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
            <tr>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Value</th>
              <th className="px-2 py-1">Source</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr
                key={s.name}
                className="border-b border-border/50 align-top"
                data-testid="setting-row"
              >
                <td className="px-2 py-1 font-mono whitespace-nowrap">
                  {s.name}
                  {s.pendingRestart && (
                    <span className="ml-1 text-warning" title="Changed; waiting for a restart">
                      ●
                    </span>
                  )}
                </td>
                <td className="max-w-xs px-2 py-1 font-mono break-all">
                  {s.value ?? '—'}
                  {s.unit ? <span className="text-muted"> {s.unit}</span> : null}
                </td>
                <td className="px-2 py-1 whitespace-nowrap text-muted">{s.source ?? ''}</td>
                <td className="px-2 py-1 text-muted">
                  {s.description ?? ''}
                  {s.restartRequired && ' (needs a restart)'}
                </td>
                <td className="px-2 py-1">
                  {s.scopes.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(s)}
                      aria-label={`Change ${s.name}`}
                    >
                      Change…
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {settings.length > shown.length && (
          <p className="p-2 text-center text-xs text-muted">Filter to see more.</p>
        )}
      </div>
      {editing && (
        <SettingDialog
          setting={editing}
          info={info}
          onCancel={() => setEditing(undefined)}
          onApply={(value, scope) => void apply(editing, value, scope)}
        />
      )}
    </div>
  );
}

function SettingDialog(props: {
  readonly setting: ServerSetting;
  readonly info: TabProps['info'];
  readonly onCancel: () => void;
  readonly onApply: (value: string | null, scope: SettingScope) => void;
}) {
  const { setting, info } = props;
  const scopes = info.settingScopes.filter((s) => setting.scopes.includes(s.scope));
  const [scope, setScope] = useState<SettingScope>(scopes[0]?.scope ?? 'global');
  const [value, setValue] = useState(setting.value ?? '');
  const choices =
    setting.type === 'bool'
      ? info.engine === 'postgres'
        ? ['on', 'off']
        : info.engine === 'mongodb'
          ? ['true', 'false']
          : ['ON', 'OFF']
      : setting.type === 'enum'
        ? setting.enumValues
        : [];
  const limits = [
    setting.min !== null ? `min ${setting.min}` : '',
    setting.max !== null ? `max ${setting.max}` : '',
    setting.defaultValue !== null ? `default ${setting.defaultValue}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onCancel()}
      title={`Change ${setting.name}`}
      {...(setting.description ? { description: setting.description } : {})}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          {info.engine !== 'mongodb' && (
            <Button onClick={() => props.onApply(null, scope)}>Reset to default</Button>
          )}
          <Button variant="primary" onClick={() => props.onApply(value, scope)}>
            Review…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={`Value${setting.unit ? ` (${setting.unit})` : ''}`}
          htmlFor="setting-value"
          hint={limits || undefined}
        >
          {choices.length > 0 ? (
            <Select id="setting-value" value={value} onChange={(e) => setValue(e.target.value)}>
              {!choices.includes(value) && <option value={value}>{value}</option>}
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="setting-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Apply to"
          htmlFor="setting-scope"
          hint={scopes.find((s) => s.scope === scope)?.description}
        >
          <Select
            id="setting-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as SettingScope)}
          >
            {scopes.map((s) => (
              <option key={s.scope} value={s.scope}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        {setting.restartRequired && (
          <p className="text-xs text-warning">This setting takes effect after a server restart.</p>
        )}
      </div>
    </Modal>
  );
}
