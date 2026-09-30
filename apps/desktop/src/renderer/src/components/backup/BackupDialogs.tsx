import type { StoredProfile } from '@joinery/ipc';

import {
  backsUp,
  closeBackupDialog,
  openBackupDialog,
  openRestoreDialog,
  useBackupDialogs,
  type BackupLocation,
} from '../../state/backup/dialogs';
import { MenuItem } from '../Sidebar';
import { BackupDialog } from './BackupDialog';
import { RestoreDialog } from './RestoreDialog';

/** Whichever backup dialog is open (the backup or the restore wizard). */
export function BackupDialogs() {
  const dialog = useBackupDialogs((state) => state.dialog);
  if (!dialog) return null;
  return dialog.kind === 'backup' ? (
    <BackupDialog
      key={JSON.stringify(dialog.target)}
      target={dialog.target}
      onClose={closeBackupDialog}
    />
  ) : (
    <RestoreDialog
      key={JSON.stringify(dialog.target)}
      target={dialog.target}
      onClose={closeBackupDialog}
    />
  );
}

/**
 * The explorer's "Back up…" and "Restore…" menu items for a connection, a database, a schema or
 * (Redis) a namespace. A read-only connection offers no restore.
 */
export function BackupMenuItems(props: {
  readonly profile: StoredProfile;
  readonly location?: BackupLocation;
  /** Redis: "Back up keys…" (a namespace offers no restore). */
  readonly restore?: boolean;
}) {
  const { profile } = props;
  if (!backsUp(profile)) return null;
  const keys = profile.engine === 'redis';
  // A MongoDB backup is of one database; the connection itself offers restores only.
  const backup = profile.engine !== 'mongodb' || props.location?.database !== undefined;
  return (
    <>
      {backup && (
        <MenuItem onSelect={() => openBackupDialog(profile, props.location)}>
          {keys ? 'Back up keys…' : 'Back up…'}
        </MenuItem>
      )}
      {props.restore !== false && !profile.presentation.readOnly && (
        <MenuItem onSelect={() => openRestoreDialog(profile, props.location)}>
          {keys ? 'Restore keys…' : 'Restore…'}
        </MenuItem>
      )}
    </>
  );
}
