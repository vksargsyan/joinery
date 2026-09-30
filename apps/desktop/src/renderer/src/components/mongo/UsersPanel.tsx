import type { Privilege, RoleRef } from '@joinery/mongo-tools';

import {
  COMMON_ACTIONS,
  resourceText,
  useUsersRoles,
  type Mechanism,
  type PrivilegeDraft,
  type ResourceKind,
  type UsersRoles,
} from '../../state/mongo/users';
import { Button, Icon, Input, Modal, cx } from '../ui';
import {
  CommandPreview,
  Labelled,
  NoticeBanner,
  RulesBanners,
  Segmented,
  ShellInput,
  SmallSelect,
} from './parts';

/**
 * The users and roles editor panel (spec §9): the database's users and roles in lists, the
 * selected one's roles and privileges (inherited ones marked), and the forms that create, edit
 * and drop them, each showing the commands it runs.
 */
export function UsersPanel({ panel }: { readonly panel: UsersRoles }) {
  const tab = useUsersRoles(panel, (s) => s.tab);
  const loading = useUsersRoles(panel, (s) => s.loading);
  const error = useUsersRoles(panel, (s) => s.error);
  const notice = useUsersRoles(panel, (s) => s.notice);
  const rules = useUsersRoles(panel, (s) => s.rules);
  const showBuiltin = useUsersRoles(panel, (s) => s.showBuiltinRoles);
  const writable = !rules.readOnlyProfile;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-users-panel"
      aria-label={`${panel.db} users and roles`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Users and roles"
      >
        <Segmented
          label="Show"
          value={tab}
          options={[
            { value: 'users', label: 'Users' },
            { value: 'roles', label: 'Roles' },
          ]}
          onChange={(value) => panel.setTab(value)}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!writable}
          onClick={() => (tab === 'users' ? panel.openUserForm() : panel.openRoleForm())}
          data-testid={tab === 'users' ? 'user-create' : 'role-create'}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          {tab === 'users' ? 'Create user…' : 'Create role…'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void panel.load()} disabled={loading}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        {tab === 'roles' && (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={showBuiltin}
              onChange={(event) => void panel.setShowBuiltinRoles(event.target.checked)}
            />
            Show built-in roles
          </label>
        )}
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted">{panel.db}</span>
      </div>
      <RulesBanners rules={rules} what="users and roles" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      {error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      {tab === 'users' ? <UsersView panel={panel} /> : <RolesView panel={panel} />}
      <UserDialog panel={panel} />
      <RoleDialog panel={panel} />
    </div>
  );
}

function refText(ref: RoleRef): string {
  return `${ref.role}@${ref.db}`;
}

function Privileges(props: { readonly privileges: readonly Privilege[] | undefined }) {
  if (!props.privileges || props.privileges.length === 0) return <p className="text-muted">None</p>;
  return (
    <ul className="flex flex-col gap-1" data-testid="privileges">
      {props.privileges.map((p, i) => (
        <li key={i} className="rounded border border-border bg-panel-2 px-2 py-1">
          <span className="font-mono">{resourceText(p)}</span>
          <span className="text-muted">: {p.actions.join(', ')}</span>
        </li>
      ))}
    </ul>
  );
}

function RoleList(props: {
  readonly roles: readonly RoleRef[];
  readonly own?: readonly RoleRef[];
}) {
  if (props.roles.length === 0) return <p className="text-muted">None</p>;
  return (
    <ul className="flex flex-wrap gap-1">
      {props.roles.map((r) => {
        const inherited =
          props.own !== undefined && !props.own.some((o) => o.role === r.role && o.db === r.db);
        return (
          <li
            key={refText(r)}
            className={cx(
              'rounded border px-1.5 py-px font-mono text-[11px]',
              inherited ? 'border-dashed border-border text-muted' : 'border-border bg-panel-2',
            )}
            title={inherited ? 'Inherited' : undefined}
          >
            {refText(r)}
          </li>
        );
      })}
    </ul>
  );
}

function UsersView({ panel }: { readonly panel: UsersRoles }) {
  const users = useUsersRoles(panel, (s) => s.users);
  const selected = useUsersRoles(panel, (s) => s.selectedUser);
  const detail = useUsersRoles(panel, (s) => s.userDetail);
  const rules = useUsersRoles(panel, (s) => s.rules);
  const user = detail?.user === selected ? detail : users.find((u) => u.user === selected);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs" data-testid="user-list">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              <th className="border-b border-border px-2 py-1 font-medium">User</th>
              <th className="border-b border-border px-2 py-1 font-medium">Roles</th>
              <th className="border-b border-border px-2 py-1 font-medium">Mechanisms</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.user}
                data-user={u.user}
                aria-selected={u.user === selected}
                tabIndex={0}
                onClick={() => panel.selectUser(u.user)}
                onKeyDown={(event) => event.key === 'Enter' && panel.selectUser(u.user)}
                className={cx(
                  'cursor-default hover:bg-hover',
                  u.user === selected && 'bg-accent/10',
                )}
              >
                <td className="border-b border-border px-2 py-1 font-mono">{u.user}</td>
                <td className="border-b border-border px-2 py-1 font-mono">
                  {u.roles.map(refText).join(', ')}
                </td>
                <td className="border-b border-border px-2 py-1 text-muted">
                  {(u.mechanisms ?? []).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p className="p-4 text-sm text-muted">No users in this database.</p>}
      </div>
      <aside
        className="flex w-[380px] shrink-0 flex-col gap-2 overflow-auto border-l border-border p-2 text-xs"
        data-testid="user-detail"
      >
        {user ? (
          <>
            <h3 className="font-mono text-[13px] font-semibold">
              {user.user}@{user.db}
            </h3>
            <div className="flex gap-1">
              <Button
                size="sm"
                disabled={rules.readOnlyProfile}
                onClick={() => panel.openUserForm(user.user)}
                data-testid="user-edit"
              >
                Edit…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                disabled={rules.readOnlyProfile}
                onClick={() => void panel.dropUser(user.user)}
                data-testid="user-drop"
              >
                Drop…
              </Button>
            </div>
            <h4 className="text-[11px] font-medium text-muted">Roles</h4>
            <RoleList roles={user.roles} />
            <h4 className="text-[11px] font-medium text-muted">
              All roles, inherited included (dashed)
            </h4>
            <RoleList roles={user.inheritedRoles ?? []} own={user.roles} />
            <h4 className="text-[11px] font-medium text-muted">Privileges (from its roles)</h4>
            <Privileges privileges={user.inheritedPrivileges} />
            {user.customData && (
              <>
                <h4 className="text-[11px] font-medium text-muted">Custom data</h4>
                <pre className="rounded border border-border bg-panel-2 p-2 font-mono">
                  {user.customData}
                </pre>
              </>
            )}
          </>
        ) : (
          <p className="text-muted">Select a user.</p>
        )}
      </aside>
    </div>
  );
}

function RolesView({ panel }: { readonly panel: UsersRoles }) {
  const roles = useUsersRoles(panel, (s) => s.roles);
  const selected = useUsersRoles(panel, (s) => s.selectedRole);
  const rules = useUsersRoles(panel, (s) => s.rules);
  const role = roles.find((r) => r.role === selected);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs" data-testid="role-list">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              <th className="border-b border-border px-2 py-1 font-medium">Role</th>
              <th className="border-b border-border px-2 py-1 font-medium">Inherits</th>
              <th className="border-b border-border px-2 py-1 font-medium">Privileges</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr
                key={`${r.role}@${r.db}`}
                data-role={r.role}
                aria-selected={r.role === selected}
                tabIndex={0}
                onClick={() => panel.selectRole(r.role)}
                onKeyDown={(event) => event.key === 'Enter' && panel.selectRole(r.role)}
                className={cx(
                  'cursor-default hover:bg-hover',
                  r.role === selected && 'bg-accent/10',
                )}
              >
                <td className="border-b border-border px-2 py-1 font-mono">
                  {r.role}
                  {r.isBuiltin && <span className="ml-1 text-[10px] text-muted">built-in</span>}
                </td>
                <td className="border-b border-border px-2 py-1 font-mono">
                  {r.roles.map(refText).join(', ')}
                </td>
                <td className="border-b border-border px-2 py-1 text-muted">
                  {(r.privileges ?? []).length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {roles.length === 0 && (
          <p className="p-4 text-sm text-muted">No custom roles in this database.</p>
        )}
      </div>
      <aside
        className="flex w-[380px] shrink-0 flex-col gap-2 overflow-auto border-l border-border p-2 text-xs"
        data-testid="role-detail"
      >
        {role ? (
          <>
            <h3 className="font-mono text-[13px] font-semibold">
              {role.role}@{role.db}
            </h3>
            {!role.isBuiltin && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  disabled={rules.readOnlyProfile}
                  onClick={() => panel.openRoleForm(role.role)}
                >
                  Edit…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={rules.readOnlyProfile}
                  onClick={() => void panel.dropRole(role.role)}
                  data-testid="role-drop"
                >
                  Drop…
                </Button>
              </div>
            )}
            <h4 className="text-[11px] font-medium text-muted">Inherits</h4>
            <RoleList roles={role.roles} />
            <h4 className="text-[11px] font-medium text-muted">Privileges</h4>
            <Privileges privileges={role.privileges} />
            <h4 className="text-[11px] font-medium text-muted">
              All privileges, inherited included
            </h4>
            <Privileges privileges={role.inheritedPrivileges} />
          </>
        ) : (
          <p className="text-muted">Select a role.</p>
        )}
      </aside>
    </div>
  );
}

function RoleRefsEditor(props: {
  readonly roles: readonly RoleRef[];
  readonly choices: readonly string[];
  readonly db: string;
  readonly onChange: (roles: RoleRef[]) => void;
  readonly label: string;
}) {
  const { roles } = props;
  const listId = `role-choices-${props.label.replace(/\W/g, '')}`;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-[11px] font-medium text-muted">{props.label}</legend>
      {roles.map((ref, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            list={listId}
            aria-label={`${props.label} ${i + 1} role`}
            value={ref.role}
            onChange={(event) =>
              props.onChange(
                roles.map((r, j) => (j === i ? { ...r, role: event.target.value } : r)),
              )
            }
            className="h-7 font-mono text-xs"
            data-testid="role-ref-role"
          />
          <span className="text-muted">@</span>
          <Input
            aria-label={`${props.label} ${i + 1} database`}
            value={ref.db}
            onChange={(event) =>
              props.onChange(roles.map((r, j) => (j === i ? { ...r, db: event.target.value } : r)))
            }
            className="h-7 w-40 font-mono text-xs"
            data-testid="role-ref-db"
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${props.label.toLowerCase()} ${i + 1}`}
            onClick={() => props.onChange(roles.filter((_r, j) => j !== i))}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <datalist id={listId}>
        {props.choices.map((choice) => (
          <option key={choice} value={choice} />
        ))}
      </datalist>
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => props.onChange([...roles, { role: '', db: props.db }])}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add role
        </Button>
      </div>
    </fieldset>
  );
}

const MECHANISMS: readonly Mechanism[] = ['SCRAM-SHA-256', 'SCRAM-SHA-1'];

function UserDialog({ panel }: { readonly panel: UsersRoles }) {
  const form = useUsersRoles(panel, (s) => s.userForm);
  const saving = useUsersRoles(panel, (s) => s.saving);
  const formError = useUsersRoles(panel, (s) => s.formError);
  useUsersRoles(panel, (s) => s.users);
  if (!form) return null;
  const plan = panel.userPlan();
  const issues: Readonly<Record<string, string>> = plan && !plan.ok ? plan.issues : {};
  const creating = form.mode === 'create';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && panel.closeForms()}
      title={creating ? `Create a user in ${panel.db}` : `Edit ${form.user}@${panel.db}`}
      width="w-[680px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => panel.closeForms()} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!plan?.ok || saving}
            onClick={() => void panel.saveUser()}
            data-testid="user-save"
          >
            {saving ? 'Saving…' : creating ? 'Create…' : 'Save…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="user-dialog">
        <div className="grid grid-cols-2 gap-2">
          <Labelled
            label="User name"
            htmlFor="user-form-name"
            error={form.user === '' ? undefined : issues['user']}
          >
            <Input
              id="user-form-name"
              value={form.user}
              disabled={!creating}
              autoFocus={creating}
              onChange={(event) => panel.updateUserForm({ user: event.target.value })}
              className="h-7 font-mono text-xs"
              data-testid="user-form-name"
            />
          </Labelled>
          <Labelled
            label={creating ? 'Password' : 'New password (empty keeps it)'}
            htmlFor="user-form-password"
            error={issues['password']}
          >
            <Input
              id="user-form-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => panel.updateUserForm({ password: event.target.value })}
              className="w-full"
              data-testid="user-form-password"
            />
          </Labelled>
        </div>
        {panel.db !== '$external' && (
          <fieldset className="flex items-center gap-3">
            <legend className="mb-1 text-[11px] font-medium text-muted">Mechanisms</legend>
            {MECHANISMS.map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.mechanisms.includes(m)}
                  onChange={(event) =>
                    panel.updateUserForm({
                      mechanisms: event.target.checked
                        ? [...form.mechanisms, m]
                        : form.mechanisms.filter((x) => x !== m),
                    })
                  }
                />
                {m}
              </label>
            ))}
            {issues['mechanisms'] && <span className="text-danger">{issues['mechanisms']}</span>}
          </fieldset>
        )}
        <RoleRefsEditor
          label="Roles"
          roles={form.roles}
          db={panel.db}
          choices={panel.roleChoices()}
          onChange={(roles) => panel.updateUserForm({ roles })}
        />
        {issues['roles'] && <p className="text-danger">{issues['roles']}</p>}
        <Labelled label="Custom data (optional)" htmlFor="user-form-custom">
          <ShellInput
            id="user-form-custom"
            value={form.customData}
            onChange={(text) => panel.updateUserForm({ customData: text })}
            placeholder="{ team: 'ops' }"
            issue={issues['customData']}
          />
        </Labelled>
        <CommandPreview
          command={
            plan?.ok
              ? plan.value.length > 0
                ? plan.value.map((op) => op.command).join('\n')
                : 'No changes'
              : undefined
          }
          testId="user-command"
        />
        <p className="text-[11px] text-muted">
          The password goes to the server once and is never shown; the command says passwordPrompt()
          in its place.
        </p>
        {formError && (
          <p role="alert" className="text-danger" data-testid="user-error">
            {formError}
          </p>
        )}
      </div>
    </Modal>
  );
}

const RESOURCES: readonly { readonly value: ResourceKind; readonly label: string }[] = [
  { value: 'database', label: 'Database' },
  { value: 'collection', label: 'Collection' },
  { value: 'cluster', label: 'Cluster' },
  { value: 'any', label: 'Any resource' },
];

function RoleDialog({ panel }: { readonly panel: UsersRoles }) {
  const form = useUsersRoles(panel, (s) => s.roleForm);
  const saving = useUsersRoles(panel, (s) => s.saving);
  const formError = useUsersRoles(panel, (s) => s.formError);
  if (!form) return null;
  const plan = panel.rolePlan();
  const issues: Readonly<Record<string, string>> = plan && !plan.ok ? plan.issues : {};
  const creating = form.mode === 'create';
  const setPrivilege = (i: number, patch: Partial<PrivilegeDraft>): void =>
    panel.updateRoleForm({
      privileges: form.privileges.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    });
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && panel.closeForms()}
      title={creating ? `Create a role in ${panel.db}` : `Edit ${form.role}@${panel.db}`}
      width="w-[760px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => panel.closeForms()} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!plan?.ok || saving}
            onClick={() => void panel.saveRole()}
            data-testid="role-save"
          >
            {saving ? 'Saving…' : creating ? 'Create…' : 'Save…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="role-dialog">
        <Labelled
          label="Role name"
          htmlFor="role-form-name"
          error={form.role === '' ? undefined : issues['role']}
        >
          <Input
            id="role-form-name"
            value={form.role}
            disabled={!creating}
            onChange={(event) => panel.updateRoleForm({ role: event.target.value })}
            className="h-7 w-72 font-mono text-xs"
            data-testid="role-form-name"
          />
        </Labelled>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] font-medium text-muted">Privileges</legend>
          {form.privileges.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <SmallSelect
                aria-label={`Privilege ${i + 1} resource`}
                value={p.resource}
                onChange={(event) =>
                  setPrivilege(i, { resource: event.target.value as ResourceKind })
                }
                className="w-32"
              >
                {RESOURCES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </SmallSelect>
              {(p.resource === 'database' || p.resource === 'collection') && (
                <Input
                  aria-label={`Privilege ${i + 1} database`}
                  placeholder="db (empty: every)"
                  value={p.db}
                  onChange={(event) => setPrivilege(i, { db: event.target.value })}
                  className="h-7 w-32 font-mono text-xs"
                />
              )}
              {p.resource === 'collection' && (
                <Input
                  aria-label={`Privilege ${i + 1} collection`}
                  placeholder="collection"
                  value={p.collection}
                  onChange={(event) => setPrivilege(i, { collection: event.target.value })}
                  className="h-7 w-32 font-mono text-xs"
                />
              )}
              <Input
                list="privilege-actions"
                aria-label={`Privilege ${i + 1} actions`}
                placeholder="find, insert, update"
                value={p.actions}
                onChange={(event) => setPrivilege(i, { actions: event.target.value })}
                className="h-7 flex-1 font-mono text-xs"
                data-testid="privilege-actions"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove privilege ${i + 1}`}
                onClick={() =>
                  panel.updateRoleForm({ privileges: form.privileges.filter((_p, j) => j !== i) })
                }
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <datalist id="privilege-actions">
            {COMMON_ACTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                panel.updateRoleForm({
                  privileges: [
                    ...form.privileges,
                    { resource: 'collection', db: panel.db, collection: '', actions: 'find' },
                  ],
                })
              }
            >
              <Icon name="plus" className="h-3.5 w-3.5" />
              Add privilege
            </Button>
          </div>
          {issues['privileges'] && <p className="text-danger">{issues['privileges']}</p>}
        </fieldset>
        <RoleRefsEditor
          label="Inherited roles"
          roles={form.roles}
          db={panel.db}
          choices={panel.roleChoices()}
          onChange={(roles) => panel.updateRoleForm({ roles })}
        />
        {issues['roles'] && <p className="text-danger">{issues['roles']}</p>}
        <CommandPreview command={plan?.ok ? plan.value.command : undefined} testId="role-command" />
        {formError && (
          <p role="alert" className="text-danger">
            {formError}
          </p>
        )}
      </div>
    </Modal>
  );
}
