import { useEffect, useState } from 'react';

import { errorMessage } from '../lib/errors';
import { mainApi } from '../lib/main-client';
import { dismissNotice, noticeFor, restartToUpdate, useUpdates } from '../state/updates';
import { Button, Icon, cx } from './ui';

/** How long the answer to a check stays up. */
const ANSWER_MS = 8000;

/**
 * The update notice in the corner of the window (spec §20): "update ready, restart" once an
 * update has downloaded, with its release notes, and the progress and answer of a check the
 * user asked for. It never takes focus; background checks stay silent.
 */
export function UpdateNotice() {
  const status = useUpdates((state) => state.status);
  const seen = useUpdates((state) => state.seenRequestId);
  const dismissed = useUpdates((state) => state.dismissedVersion);
  const aboutOpen = useUpdates((state) => state.aboutOpen);
  const [error, setError] = useState<string>();
  const notice = noticeFor(status, seen, dismissed);
  const answer = notice?.kind === 'answer' ? notice.text : undefined;

  // An answer puts itself away; the About box, which shows the status itself, takes it at once.
  useEffect(() => {
    if (answer === undefined) return;
    const timer = setTimeout(dismissNotice, aboutOpen ? 0 : ANSWER_MS);
    return () => clearTimeout(timer);
  }, [answer, aboutOpen]);

  if (!notice || (aboutOpen && notice.kind !== 'ready')) return null;
  const notesUrl = status?.releaseNotesUrl;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-notice"
      className={cx(
        'fixed right-4 bottom-4 z-30 flex max-w-sm flex-col gap-2 rounded-lg border bg-raised px-4 py-3 shadow-widget',
        notice.kind === 'answer' && notice.tone === 'error' ? 'border-danger' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <p className="flex-1 text-[13px]">
          {notice.kind !== 'ready'
            ? notice.text
            : notice.installsOnQuit
              ? `Querybara ${notice.version} is ready. Restart now, or it installs when you quit.`
              : `Querybara ${notice.version} is ready. Restart now to install it; your system asks for an administrator password.`}
        </p>
        {notice.kind !== 'ready' && (
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted hover:text-fg"
            onClick={dismissNotice}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {notice.kind === 'ready' && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setError(undefined);
              restartToUpdate().catch((failure: unknown) => setError(errorMessage(failure)));
            }}
          >
            Restart now
          </Button>
          {notesUrl !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void mainApi()
                  .app.openExternal({ url: notesUrl })
                  .catch(() => undefined)
              }
            >
              Release notes
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={dismissNotice}>
            Later
          </Button>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
