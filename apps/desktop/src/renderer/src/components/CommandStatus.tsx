import { useCommands } from '../state/commands';
import { Icon, cx } from './ui';

/**
 * A short message at the bottom of the window, as VS Code's status bar shows one: a chord
 * waiting for its second key, or a command that failed.
 */
export function CommandStatus() {
  const status = useCommands((s) => s.status);
  if (!status) return null;
  return (
    <div
      role={status.kind === 'error' ? 'alert' : 'status'}
      data-testid="command-status"
      className={cx(
        'pointer-events-none fixed bottom-8 left-1/2 z-50 flex max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-md border bg-raised px-3 py-1.5 text-xs shadow-widget',
        status.kind === 'error' ? 'border-danger/50 text-danger' : 'border-border text-fg',
      )}
    >
      <Icon name={status.kind === 'error' ? 'warning' : 'settings'} className="h-3.5 w-3.5" />
      {status.text}
    </div>
  );
}
