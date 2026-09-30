import {
  DEFAULT_PRIVILEGE_TYPES,
  POLICY_COMMANDS,
  parseServerVersion,
  type ActionResult,
  type DefaultPrivilege,
  type DefaultPrivilegeType,
  type PolicyCommand,
  type RlsTable,
  type ServerAction,
} from '@joinery/core';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { Notice, Toolbar } from '../redis/common';
import { Button, Field, Input, Modal, Select } from '../ui';
import {
  ActionOutcome,
  Check,
  NoticeList,
  SectionTitle,
  ToolSelect,
  runAction,
  useToolData,
  type TabProps,
} from './common';

/**
 * PostgreSQL default privileges (ALTER DEFAULT PRIVILEGES: what objects created later grant)
 * and row-level security (the per-table switch and its policies), for one schema of one
 * database. Each change shows its statement first.
 */

function defaultPrivilegeChoices(type: DefaultPrivilegeType, version: string): string[] {
  const major = parseServerVersion(version)?.major ?? 0;
  switch (type) {
    case 'tables':
      return [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        ...(major >= 17 ? ['MAINTAIN'] : []),
      ];
    case 'sequences':
      return ['USAGE', 'SELECT', 'UPDATE'];
    case 'functions':
      return ['EXECUTE'];
    case 'types':
      return ['USAGE'];
    case 'schemas':
      return ['USAGE', 'CREATE'];
  }
}

export function PgAccessTab(props: TabProps & { readonly view: 'defaults' | 'policies' }) {
  const { panelId, info } = props;
  const [database, setDatabase] = useState<string | undefined>(info.database ?? undefined);
  const [schema, setSchema] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();
  const details = useToolData(
    panelId,
    database,
    (host, sessionId) =>
      host.serverTools.accessDetails({ sessionId, ...(schema !== undefined ? { schema } : {}) }),
    [schema],
  );
  const roles = useToolData(
    panelId,
    undefined,
    (host, sessionId) => host.serverTools.accounts({ sessionId }),
    [],
  );
  const roleNames = (roles.data?.accounts ?? []).filter((a) => !a.builtin).map((a) => a.name);
  const act = async (action: ServerAction, confirmLabel: string): Promise<boolean> => {
    setError(undefined);
    try {
      const done = await runAction(panelId, action, {
        ...(database !== undefined ? { database } : {}),
        confirmLabel,
      });
      if (!done) return false;
      setResult(done);
      await details.reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const data = details.data;
  return (
    <div className="flex h-full flex-col" data-testid={`server-${props.view}`}>
      <Toolbar label={props.view === 'defaults' ? 'Default privileges' : 'Row-level security'}>
        <ToolSelect
          label="Database"
          value={database ?? ''}
          onChange={(v) => {
            setDatabase(v);
            setSchema(undefined);
          }}
          options={info.databases.map((d) => ({ value: d, label: d }))}
        />
        <ToolSelect
          label="Schema"
          value={data?.schema ?? ''}
          onChange={setSchema}
          options={(data?.schemas ?? []).map((s) => ({ value: s, label: s }))}
        />
        <Button size="sm" onClick={() => void details.reload()} disabled={details.loading}>
          Refresh
        </Button>
      </Toolbar>
      {(error ?? details.error) && <Notice kind="error">{error ?? details.error}</Notice>}
      <NoticeList notices={data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {data && props.view === 'defaults' && (
          <DefaultPrivileges
            info={info}
            schema={data.schema}
            entries={data.defaultPrivileges}
            roles={roleNames}
            act={act}
          />
        )}
        {data && props.view === 'policies' && (
          <Policies schema={data.schema} tables={data.tables} roles={roleNames} act={act} />
        )}
      </div>
    </div>
  );
}

function DefaultPrivileges(props: {
  readonly info: TabProps['info'];
  readonly schema: string;
  readonly entries: readonly DefaultPrivilege[];
  readonly roles: readonly string[];
  readonly act: (action: ServerAction, confirmLabel: string) => Promise<boolean>;
}) {
  const [owner, setOwner] = useState('');
  const [inSchema, setInSchema] = useState(true);
  const [objectType, setObjectType] = useState<DefaultPrivilegeType>('tables');
  const [grantee, setGrantee] = useState('');
  const [privileges, setPrivileges] = useState<ReadonlySet<string>>(new Set(['SELECT']));
  const [grantOption, setGrantOption] = useState(false);
  const choices = defaultPrivilegeChoices(objectType, props.info.version);
  const grant = (): void => {
    const list = choices.filter((p) => privileges.has(p));
    if (grantee === '' || list.length === 0) return;
    void props.act(
      {
        kind: 'defaultPrivileges',
        operation: 'grant',
        ...(owner !== '' ? { owner } : {}),
        ...(inSchema && objectType !== 'schemas' ? { schema: props.schema } : {}),
        objectType,
        grantee,
        privileges: list,
        ...(grantOption ? { grantOption } : {}),
      },
      'Grant',
    );
  };
  return (
    <>
      <SectionTitle>Default privileges</SectionTitle>
      <table
        className="w-full text-xs"
        aria-label="Default privileges"
        data-testid="default-privileges"
      >
        <thead className="text-left text-[11px] text-muted uppercase">
          <tr>
            <th className="px-2 py-1">Objects created by</th>
            <th className="px-2 py-1">In schema</th>
            <th className="px-2 py-1">Type</th>
            <th className="px-2 py-1">Grantee</th>
            <th className="px-2 py-1">Privileges</th>
            <th className="px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {props.entries.map((e) => (
            <tr
              key={`${e.owner}|${e.schema ?? ''}|${e.objectType}|${e.grantee}`}
              className="border-t border-border/50"
            >
              <td className="px-2 py-1 font-mono">{e.owner}</td>
              <td className="px-2 py-1 font-mono">{e.schema ?? '(every schema)'}</td>
              <td className="px-2 py-1">{e.objectType}</td>
              <td className="px-2 py-1 font-mono">{e.grantee}</td>
              <td className="px-2 py-1">
                {e.privileges.map((p) => (e.grantable.includes(p) ? `${p}+` : p)).join(', ')}
              </td>
              <td className="px-2 py-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void props.act(
                      {
                        kind: 'defaultPrivileges',
                        operation: 'revoke',
                        owner: e.owner,
                        ...(e.schema !== null ? { schema: e.schema } : {}),
                        objectType: e.objectType,
                        grantee: e.grantee,
                        privileges: e.privileges,
                      },
                      'Revoke',
                    )
                  }
                >
                  Revoke…
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.entries.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted">No default privileges are set.</p>
      )}
      <section
        className="mt-4 rounded border border-border p-3"
        aria-label="Add default privileges"
      >
        <SectionTitle>Grant on objects created later</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <ToolSelect
            label="Created by"
            value={owner}
            onChange={setOwner}
            options={[
              { value: '', label: '(me)' },
              ...props.roles.map((r) => ({ value: r, label: r })),
            ]}
          />
          <ToolSelect
            label="Type"
            value={objectType}
            onChange={(v) => {
              setObjectType(v as DefaultPrivilegeType);
              setPrivileges(new Set());
            }}
            options={DEFAULT_PRIVILEGE_TYPES.map((t) => ({ value: t, label: t }))}
          />
          <Check
            label={`Only in ${props.schema}`}
            checked={inSchema && objectType !== 'schemas'}
            disabled={objectType === 'schemas'}
            onChange={setInSchema}
          />
          <ToolSelect
            label="To"
            value={grantee}
            onChange={setGrantee}
            options={[
              { value: '', label: '(pick a role)' },
              { value: 'PUBLIC', label: 'PUBLIC' },
              ...props.roles.map((r) => ({ value: r, label: r })),
            ]}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {choices.map((p) => (
            <Check
              key={p}
              label={p}
              checked={privileges.has(p)}
              onChange={(on) => {
                const next = new Set(privileges);
                if (on) next.add(p);
                else next.delete(p);
                setPrivileges(next);
              }}
            />
          ))}
          <Check label="With grant option" checked={grantOption} onChange={setGrantOption} />
          <Button
            size="sm"
            variant="primary"
            disabled={grantee === '' || privileges.size === 0}
            onClick={grant}
          >
            Grant…
          </Button>
        </div>
      </section>
    </>
  );
}

function Policies(props: {
  readonly schema: string;
  readonly tables: readonly RlsTable[];
  readonly roles: readonly string[];
  readonly act: (action: ServerAction, confirmLabel: string) => Promise<boolean>;
}) {
  const [creating, setCreating] = useState<string>();
  return (
    <>
      <SectionTitle>Tables in {props.schema}</SectionTitle>
      {props.tables.length === 0 && <p className="text-xs text-muted">No tables.</p>}
      <ul className="flex flex-col gap-3" data-testid="rls-tables">
        {props.tables.map((t) => (
          <li key={t.table} className="rounded border border-border p-2" data-testid="rls-table">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold">{t.table}</span>
              <span className={t.enabled ? 'text-success' : 'text-muted'}>
                {t.enabled ? 'row-level security on' : 'row-level security off'}
                {t.forced ? ' (forced for the owner)' : ''}
              </span>
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={() =>
                  void props.act(
                    { kind: 'rowSecurity', schema: t.schema, table: t.table, enabled: !t.enabled },
                    t.enabled ? 'Disable' : 'Enable',
                  )
                }
              >
                {t.enabled ? 'Disable…' : 'Enable…'}
              </Button>
              {t.enabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void props.act(
                      {
                        kind: 'rowSecurity',
                        schema: t.schema,
                        table: t.table,
                        enabled: true,
                        forced: !t.forced,
                      },
                      'Apply',
                    )
                  }
                >
                  {t.forced ? 'Do not force…' : 'Force for owner…'}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setCreating(t.table)}>
                New policy…
              </Button>
            </div>
            {t.policies.length > 0 && (
              <table className="mt-1 w-full text-xs" aria-label={`Policies of ${t.table}`}>
                <thead className="text-left text-[11px] text-muted uppercase">
                  <tr>
                    <th className="px-2 py-0.5">Policy</th>
                    <th className="px-2 py-0.5">Kind</th>
                    <th className="px-2 py-0.5">For</th>
                    <th className="px-2 py-0.5">To</th>
                    <th className="px-2 py-0.5">Using</th>
                    <th className="px-2 py-0.5">With check</th>
                    <th className="px-2 py-0.5" />
                  </tr>
                </thead>
                <tbody>
                  {t.policies.map((p) => (
                    <tr key={p.name} className="border-t border-border/50" data-testid="rls-policy">
                      <td className="px-2 py-0.5 font-mono">{p.name}</td>
                      <td className="px-2 py-0.5">{p.permissive ? 'permissive' : 'restrictive'}</td>
                      <td className="px-2 py-0.5">{p.command}</td>
                      <td className="px-2 py-0.5 font-mono">{p.roles.join(', ')}</td>
                      <td className="px-2 py-0.5 font-mono">{p.using ?? ''}</td>
                      <td className="px-2 py-0.5 font-mono">{p.withCheck ?? ''}</td>
                      <td className="px-2 py-0.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void props.act(
                              {
                                kind: 'dropPolicy',
                                schema: t.schema,
                                table: t.table,
                                name: p.name,
                              },
                              'Drop',
                            )
                          }
                        >
                          Drop…
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
      {creating !== undefined && (
        <PolicyDialog
          schema={props.schema}
          table={creating}
          roles={props.roles}
          onCancel={() => setCreating(undefined)}
          onSubmit={(action) => {
            setCreating(undefined);
            void props.act(action, 'Create');
          }}
        />
      )}
    </>
  );
}

function PolicyDialog(props: {
  readonly schema: string;
  readonly table: string;
  readonly roles: readonly string[];
  readonly onCancel: () => void;
  readonly onSubmit: (action: ServerAction) => void;
}) {
  const [name, setName] = useState('');
  const [permissive, setPermissive] = useState(true);
  const [command, setCommand] = useState<PolicyCommand>('ALL');
  const [roles, setRoles] = useState('public');
  const [using, setUsing] = useState('');
  const [withCheck, setWithCheck] = useState('');
  const [error, setError] = useState<string>();
  const submit = (): void => {
    if (name.trim() === '') {
      setError('Give the policy a name');
      return;
    }
    const takesUsing = command !== 'INSERT';
    const takesCheck = command !== 'SELECT' && command !== 'DELETE';
    props.onSubmit({
      kind: 'createPolicy',
      schema: props.schema,
      table: props.table,
      name: name.trim(),
      permissive,
      command,
      roles: roles
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r !== ''),
      ...(takesUsing && using.trim() !== '' ? { using } : {}),
      ...(takesCheck && withCheck.trim() !== '' ? { withCheck } : {}),
    });
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onCancel()}
      title={`New policy on ${props.schema}.${props.table}`}
      width="w-[600px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Review…
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" htmlFor="policy-name" error={error}>
          <Input
            id="policy-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Command" htmlFor="policy-command">
          <Select
            id="policy-command"
            value={command}
            onChange={(e) => setCommand(e.target.value as PolicyCommand)}
          >
            {POLICY_COMMANDS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Kind"
          htmlFor="policy-kind"
          hint="Restrictive policies must all pass; permissive ones combine with OR"
        >
          <Select
            id="policy-kind"
            value={permissive ? 'permissive' : 'restrictive'}
            onChange={(e) => setPermissive(e.target.value === 'permissive')}
          >
            <option value="permissive">PERMISSIVE</option>
            <option value="restrictive">RESTRICTIVE</option>
          </Select>
        </Field>
        <Field
          label="Roles"
          htmlFor="policy-roles"
          hint={`Comma-separated; public for everyone${props.roles.length > 0 ? ` (e.g. ${props.roles.slice(0, 3).join(', ')})` : ''}`}
        >
          <Input id="policy-roles" value={roles} onChange={(e) => setRoles(e.target.value)} />
        </Field>
        {command !== 'INSERT' && (
          <Field
            label="USING (rows it can see or change)"
            htmlFor="policy-using"
            className="col-span-2"
          >
            <textarea
              id="policy-using"
              className="h-16 w-full rounded border border-border bg-panel-2 p-2 font-mono text-xs"
              value={using}
              onChange={(e) => setUsing(e.target.value)}
              placeholder="owner = current_user"
            />
          </Field>
        )}
        {command !== 'SELECT' && command !== 'DELETE' && (
          <Field
            label="WITH CHECK (rows it can write)"
            htmlFor="policy-check"
            className="col-span-2"
          >
            <textarea
              id="policy-check"
              className="h-16 w-full rounded border border-border bg-panel-2 p-2 font-mono text-xs"
              value={withCheck}
              onChange={(e) => setWithCheck(e.target.value)}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
