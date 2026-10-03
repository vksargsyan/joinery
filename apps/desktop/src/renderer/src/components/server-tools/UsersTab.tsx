import type {
  AccountRef,
  ActionResult,
  GrantMatrix,
  ServerAccount,
  ServerAction,
} from '@querybara/core';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { panelState } from '../../state/server-tools/panels';
import {
  GRANT_STATE_LABELS,
  accountAction,
  accountForm,
  accountName,
  accountRef,
  grantGroups,
  toggleGrant,
  type AccountForm,
} from '../../state/server-tools/view';
import { openMongoTool } from '../mongo/open';
import { Notice, Toolbar } from '../redis/common';
import { Button, Field, Input, Modal, cx } from '../ui';
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
import { PgAccessTab } from './PgAccessTab';

/**
 * Users and roles (spec §15): accounts with their attributes and role memberships, the grants
 * matrix (objects × privileges; click a cell to grant or revoke), and create, alter and drop.
 * PostgreSQL adds default privileges and row-level security policies. Every change shows its
 * statement first; passwords are masked there. MongoDB users live in the MongoDB module.
 */

type UsersView = 'accounts' | 'defaults' | 'policies';

export function UsersTab(props: TabProps) {
  const { info, panelId } = props;
  const [view, setView] = useState<UsersView>('accounts');
  if (info.access.length === 0) {
    const { profileId } = panelState(panelId);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-md text-sm text-muted">
          MongoDB users and roles are managed in the MongoDB module's users and roles editor, with
          their privileges, inherited roles and authentication restrictions.
        </p>
        <Button
          variant="primary"
          onClick={() =>
            openMongoTool({ tool: 'users', target: { profileId, db: 'admin', tab: 'users' } })
          }
        >
          Open users and roles
        </Button>
      </div>
    );
  }
  const views: { id: UsersView; label: string }[] = [
    { id: 'accounts', label: info.access.includes('hosts') ? 'Users and roles' : 'Roles' },
    ...(info.access.includes('defaultPrivileges')
      ? [{ id: 'defaults' as const, label: 'Default privileges' }]
      : []),
    ...(info.access.includes('policies')
      ? [{ id: 'policies' as const, label: 'Row-level security' }]
      : []),
  ];
  return (
    <div className="flex h-full flex-col">
      {views.length > 1 && (
        <div
          role="tablist"
          aria-label="Users"
          className="flex gap-1 border-b border-border px-2 py-1"
        >
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={cx(
                'rounded px-2 py-1 text-xs',
                view === v.id ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {view === 'accounts' && <AccountsView {...props} />}
        {view !== 'accounts' && <PgAccessTab {...props} view={view} />}
      </div>
    </div>
  );
}

function AccountsView({ panelId, info }: TabProps) {
  const mysql = info.access.includes('hosts');
  const [filter, setFilter] = useState('');
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [dialog, setDialog] = useState<{ existing?: ServerAccount; role: boolean }>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();
  const accounts = useToolData(
    panelId,
    undefined,
    (host, sessionId) => host.serverTools.accounts({ sessionId }),
    [],
  );
  const needle = filter.trim().toLowerCase();
  const list = (accounts.data?.accounts ?? []).filter(
    (a) =>
      (showBuiltin || !a.builtin) &&
      (needle === '' || accountName(a).toLowerCase().includes(needle)),
  );
  const current = accounts.data?.accounts.find((a) => accountName(a) === selected);
  const roles = (accounts.data?.accounts ?? []).filter((a) => a.kind === 'role' || !mysql);

  const act = async (action: ServerAction, confirmLabel: string): Promise<boolean> => {
    setError(undefined);
    try {
      const done = await runAction(panelId, action, { confirmLabel });
      if (!done) return false;
      setResult(done);
      await accounts.reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="server-users">
      <Toolbar label="Accounts">
        <Input
          aria-label="Filter accounts"
          placeholder="Filter"
          className="h-7 w-48 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Check label="Built-in" checked={showBuiltin} onChange={setShowBuiltin} />
        <Button size="sm" onClick={() => void accounts.reload()} disabled={accounts.loading}>
          Refresh
        </Button>
        <span className="flex-1" />
        <Button size="sm" onClick={() => setDialog({ role: false })}>
          New user…
        </Button>
        {info.access.includes('roles') && (
          <Button size="sm" onClick={() => setDialog({ role: true })}>
            New role…
          </Button>
        )}
      </Toolbar>
      {(error ?? accounts.error) && <Notice kind="error">{error ?? accounts.error}</Notice>}
      <NoticeList notices={accounts.data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="flex min-h-0 flex-1">
        <ul
          aria-label="Accounts"
          className="w-64 shrink-0 overflow-auto border-r border-border py-1 text-xs"
          data-testid="account-list"
        >
          {list.map((a) => (
            <li key={accountName(a)}>
              <button
                type="button"
                aria-current={accountName(a) === selected}
                className={cx(
                  'flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-hover',
                  accountName(a) === selected && 'bg-accent/15',
                )}
                onClick={() => setSelected(accountName(a))}
              >
                <span className="truncate font-mono">{accountName(a)}</span>
                <span className="ml-auto rounded bg-panel-2 px-1 text-[10px] text-muted">
                  {a.kind}
                </span>
                {a.superuser && (
                  <span className="rounded bg-warning/20 px-1 text-[10px] text-warning">super</span>
                )}
                {a.locked && (
                  <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">locked</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 overflow-auto">
          {current ? (
            <AccountDetails
              key={accountName(current)}
              panelId={panelId}
              info={info}
              account={current}
              roles={roles}
              act={act}
              onEdit={() => setDialog({ existing: current, role: current.kind === 'role' })}
            />
          ) : (
            <p className="p-4 text-xs text-muted">Pick an account to see its roles and grants.</p>
          )}
        </div>
      </div>
      {dialog && (
        <AccountDialog
          info={info}
          role={dialog.role}
          {...(dialog.existing ? { existing: dialog.existing } : {})}
          onCancel={() => setDialog(undefined)}
          onSubmit={(action) => {
            setDialog(undefined);
            void act(action, dialog.existing ? 'Apply' : 'Create').then((ok) => {
              if (ok && action.kind === 'createAccount') setSelected(accountName(action.account));
            });
          }}
        />
      )}
    </div>
  );
}

function AccountDetails(props: {
  readonly panelId: string;
  readonly info: TabProps['info'];
  readonly account: ServerAccount;
  readonly roles: readonly ServerAccount[];
  readonly act: (action: ServerAction, confirmLabel: string) => Promise<boolean>;
  readonly onEdit: () => void;
}) {
  const { account, info, act } = props;
  const ref = accountRef(account);
  const [grantRole, setGrantRole] = useState('');
  const [admin, setAdmin] = useState(false);
  const candidates = props.roles.filter(
    (r) =>
      accountName(r) !== accountName(account) &&
      !account.memberOf.some((m) => accountName(m.role) === accountName(r)),
  );
  return (
    <div className="p-3" data-testid="account-details">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-semibold">{accountName(account)}</h3>
        <span className="text-xs text-muted">
          {account.kind}
          {account.canLogin ? ' · can log in' : ' · no login'}
          {account.superuser ? ' · superuser' : ''}
          {account.connectionLimit !== null && account.connectionLimit !== undefined
            ? ` · ${account.connectionLimit} connections max`
            : ''}
          {account.validUntil ? ` · valid until ${account.validUntil}` : ''}
          {account.attributes.length > 0 ? ` · ${account.attributes.join(', ')}` : ''}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={props.onEdit}>
          Edit…
        </Button>
        {!account.builtin && (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void act({ kind: 'dropAccount', account: ref, role: account.kind === 'role' }, 'Drop')
            }
          >
            Drop…
          </Button>
        )}
      </div>
      {info.access.includes('membership') && (
        <section className="mt-3">
          <SectionTitle>Member of</SectionTitle>
          {account.memberOf.length === 0 && <p className="text-xs text-muted">No roles.</p>}
          <ul className="flex flex-col gap-1 text-xs" data-testid="memberships">
            {account.memberOf.map((m) => (
              <li key={accountName(m.role)} className="flex items-center gap-2">
                <span className="font-mono">{accountName(m.role)}</span>
                {m.admin && <span className="text-muted">with admin option</span>}
                {m.inherit === false && <span className="text-muted">no inherit</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act({ kind: 'revokeRole', role: m.role, member: ref }, 'Revoke')
                  }
                >
                  Revoke…
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <ToolSelect
              label="Grant role"
              value={grantRole}
              onChange={setGrantRole}
              options={[
                { value: '', label: '(pick a role)' },
                ...candidates.map((r) => ({ value: accountName(r), label: accountName(r) })),
              ]}
            />
            <Check label="With admin option" checked={admin} onChange={setAdmin} />
            <Button
              size="sm"
              disabled={grantRole === ''}
              onClick={() => {
                const role = props.roles.find((r) => accountName(r) === grantRole);
                if (!role) return;
                void act(
                  {
                    kind: 'grantRole',
                    role: accountRef(role),
                    member: ref,
                    ...(admin ? { admin } : {}),
                  },
                  'Grant',
                ).then((ok) => ok && setGrantRole(''));
              }}
            >
              Grant…
            </Button>
          </div>
        </section>
      )}
      <GrantsSection panelId={props.panelId} info={info} grantee={ref} />
    </div>
  );
}

function GrantsSection(props: {
  readonly panelId: string;
  readonly info: TabProps['info'];
  readonly grantee: AccountRef;
}) {
  const { info } = props;
  const [database, setDatabase] = useState<string | undefined>(
    info.perDatabaseSessions ? (info.database ?? undefined) : undefined,
  );
  const [scope, setScope] = useState<string>();
  const [filter, setFilter] = useState('');
  const [grantOption, setGrantOption] = useState(false);
  const matrix = useToolData(
    props.panelId,
    database,
    (host, sessionId) =>
      host.serverTools.grants({
        sessionId,
        grantee: props.grantee,
        ...(scope !== undefined ? { scope } : {}),
      }),
    [scope, props.grantee.name, props.grantee.host],
  );
  const [error, setError] = useState<string>();
  // Grants run on the session the matrix was read from (PostgreSQL: the right database).
  const toggle = async (action: ServerAction): Promise<void> => {
    setError(undefined);
    try {
      const done = await runAction(props.panelId, action, {
        ...(database !== undefined ? { database } : {}),
        confirmLabel: action.kind === 'grant' ? 'Grant' : 'Revoke',
      });
      if (done) await matrix.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="mt-4" data-testid="grants-matrix">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>Grants</SectionTitle>
        {info.perDatabaseSessions && (
          <ToolSelect
            label="Database"
            value={database ?? ''}
            onChange={(v) => {
              setDatabase(v);
              setScope(undefined);
            }}
            options={info.databases.map((d) => ({ value: d, label: d }))}
          />
        )}
        <ToolSelect
          label={info.engine === 'postgres' ? 'Schema' : 'Database'}
          value={matrix.data?.scope ?? ''}
          onChange={setScope}
          options={(matrix.data?.scopes ?? []).map((s) => ({ value: s, label: s }))}
        />
        <Input
          aria-label="Filter objects"
          placeholder="Filter objects"
          className="h-7 w-40 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Check label="Grant with grant option" checked={grantOption} onChange={setGrantOption} />
      </div>
      {(error ?? matrix.error) && <Notice kind="error">{error ?? matrix.error}</Notice>}
      <NoticeList notices={matrix.data?.notices ?? []} />
      {matrix.data && (
        <Matrix
          matrix={matrix.data}
          filter={filter}
          onToggle={(row, privilege) =>
            void toggle(toggleGrant(props.grantee, row, privilege, grantOption))
          }
        />
      )}
      <p className="mt-2 text-[11px] text-muted">
        ✓ granted · ✓+ with grant option · ○ held another way (ownership, a role, PUBLIC or a wider
        grant). Click a cell to grant or revoke.
      </p>
    </section>
  );
}

const MARKS = { none: '', granted: '✓', grantable: '✓+', implied: '○' } as const;

function Matrix(props: {
  readonly matrix: GrantMatrix;
  readonly filter: string;
  readonly onToggle: (row: GrantMatrix['rows'][number], privilege: string) => void;
}) {
  const groups = grantGroups(props.matrix, props.filter);
  return (
    <div className="mt-2 flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.kind} className="overflow-x-auto">
          <table
            className="text-xs"
            aria-label={`${group.title} privileges`}
            data-testid={`grants-${group.kind}`}
          >
            <thead>
              <tr>
                <th className="px-2 py-1 text-left text-[11px] font-semibold text-muted uppercase">
                  {group.title}
                </th>
                {group.privileges.map((p) => (
                  <th
                    key={p}
                    className="px-1 py-1 text-[10px] font-semibold whitespace-nowrap text-muted"
                  >
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={`${row.object.kind}:${row.label}`} className="border-t border-border/50">
                  <td className="px-2 py-0.5 font-mono whitespace-nowrap" title={row.type}>
                    {row.label}
                  </td>
                  {group.privileges.map((p) => {
                    const state = row.privileges[p] ?? 'none';
                    return (
                      <td key={p} className="px-0.5 py-0.5 text-center">
                        <button
                          type="button"
                          aria-label={`${p} on ${row.label}: ${GRANT_STATE_LABELS[state]}`}
                          data-state={state}
                          className={cx(
                            'h-6 w-9 rounded border text-[11px]',
                            state === 'granted' || state === 'grantable'
                              ? 'border-accent/50 bg-accent/20 text-fg'
                              : state === 'implied'
                                ? 'border-border bg-panel-2 text-muted'
                                : 'border-border/50 hover:bg-hover',
                          )}
                          onClick={() => props.onToggle(row, p)}
                        >
                          {MARKS[state]}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function AccountDialog(props: {
  readonly info: TabProps['info'];
  readonly role: boolean;
  readonly existing?: ServerAccount;
  readonly onCancel: () => void;
  readonly onSubmit: (action: ServerAction) => void;
}) {
  const { info, existing } = props;
  const postgres = info.engine === 'postgres';
  const hosts = info.access.includes('hosts') && !(info.engine === 'mariadb' && props.role);
  const [form, setForm] = useState<AccountForm>(() =>
    accountForm(info.engine, existing, props.role),
  );
  const [error, setError] = useState<string>();
  const set = <K extends keyof AccountForm>(key: K, value: AccountForm[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));
  const what = props.role ? 'role' : 'user';
  const submit = (): void => {
    if (form.name.trim() === '') {
      setError('Give a name');
      return;
    }
    const action = accountAction(info.engine, form, existing);
    if (
      action.kind === 'alterAccount' &&
      Object.keys(action.options).length === 0 &&
      !action.rename
    ) {
      setError('Nothing changed');
      return;
    }
    props.onSubmit(action);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onCancel()}
      title={existing ? `Edit ${accountName(existing)}` : `New ${what}`}
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
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Name"
          htmlFor="account-name"
          error={error}
          className={hosts ? '' : 'col-span-2'}
        >
          <Input
            id="account-name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            autoFocus
          />
        </Field>
        {hosts && (
          <Field label="Host" htmlFor="account-host" hint="% for any host">
            <Input
              id="account-host"
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
            />
          </Field>
        )}
        {(postgres || !props.role) && (
          <Field
            label={existing ? 'New password' : 'Password'}
            htmlFor="account-password"
            hint={
              existing ? 'Leave empty to keep the current one' : 'Masked in the statement preview'
            }
            className="col-span-2"
          >
            <Input
              id="account-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
            />
          </Field>
        )}
        {(postgres || !props.role) && (
          <Field label="Connection limit" htmlFor="account-limit" hint="Empty for no limit">
            <Input
              id="account-limit"
              inputMode="numeric"
              value={form.connectionLimit}
              onChange={(e) => set('connectionLimit', e.target.value)}
            />
          </Field>
        )}
        {postgres && (
          <Field label="Valid until" htmlFor="account-valid" hint="A timestamp; empty for always">
            <Input
              id="account-valid"
              value={form.validUntil}
              onChange={(e) => set('validUntil', e.target.value)}
            />
          </Field>
        )}
        <div className="col-span-2 flex flex-wrap gap-3">
          {postgres ? (
            <>
              <Check label="LOGIN" checked={form.login} onChange={(v) => set('login', v)} />
              <Check
                label="SUPERUSER"
                checked={form.superuser}
                onChange={(v) => set('superuser', v)}
              />
              <Check
                label="CREATEDB"
                checked={form.createDb}
                onChange={(v) => set('createDb', v)}
              />
              <Check
                label="CREATEROLE"
                checked={form.createRole}
                onChange={(v) => set('createRole', v)}
              />
              <Check
                label="REPLICATION"
                checked={form.replication}
                onChange={(v) => set('replication', v)}
              />
              <Check
                label="BYPASSRLS"
                checked={form.bypassRls}
                onChange={(v) => set('bypassRls', v)}
              />
              <Check label="INHERIT" checked={form.inherit} onChange={(v) => set('inherit', v)} />
            </>
          ) : (
            !props.role && (
              <Check
                label="Account locked"
                checked={form.locked}
                onChange={(v) => set('locked', v)}
              />
            )
          )}
        </div>
      </form>
    </Modal>
  );
}
