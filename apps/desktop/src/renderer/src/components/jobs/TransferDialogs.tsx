import { closeTransferDialog, useTransferDialogs } from '../../state/transfer-dialogs';
import { ExportWizardDialog } from './ExportWizard';
import { ImportWizardDialog } from './ImportWizard';
import { RunSqlFileDialog } from './RunSqlFileDialog';

/** Whichever transfer dialog is open (import wizard, export wizard, Run SQL File). */
export function TransferDialogs() {
  const dialog = useTransferDialogs((state) => state.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'import':
      return <ImportWizardDialog target={dialog.target} onClose={closeTransferDialog} />;
    case 'export':
      return (
        <ExportWizardDialog
          source={dialog.source}
          {...(dialog.tablesPath ? { tablesPath: dialog.tablesPath } : {})}
          onClose={closeTransferDialog}
        />
      );
    case 'run-sql-file':
      return <RunSqlFileDialog target={dialog.target} onClose={closeTransferDialog} />;
  }
}
