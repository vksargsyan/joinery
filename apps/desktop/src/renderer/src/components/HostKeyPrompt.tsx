import type { HostKeyAnswer, HostKeyPrompt } from '@joinery/ipc';
import { useEffect, useState } from 'react';

import { mainApi } from '../lib/main-client';
import { Button, Icon, Modal } from './ui';

/**
 * SSH host key questions (spec §4). A connection host opening a tunnel asks main, and main asks
 * here: for a server Joinery has not seen, Trust once / Trust and remember / Cancel; for a server
 * whose key changed, a blocking warning whose only way forward, after checking with the server's
 * administrator, is removing the remembered key (main then asks about the new key). Closing a
 * dialog cancels, and main cancels a question nobody answers in time.
 */
export function HostKeyPrompts() {
  const [prompts, setPrompts] = useState<readonly HostKeyPrompt[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const follow = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const events = mainApi().hostKeys.prompts(undefined, { signal: controller.signal });
          for await (const event of events) {
            if (event.type === 'open') {
              const { prompt } = event;
              setPrompts((open) =>
                open.some((p) => p.promptId === prompt.promptId) ? open : [...open, prompt],
              );
            } else {
              setPrompts((open) => open.filter((p) => p.promptId !== event.promptId));
            }
          }
          return;
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void follow();
    return () => controller.abort();
  }, []);

  const current = prompts[0];
  if (!current) return null;
  const answer = (value: HostKeyAnswer): void => {
    setPrompts((open) => open.filter((p) => p.promptId !== current.promptId));
    void mainApi()
      .hostKeys.answer({ promptId: current.promptId, answer: value })
      .catch(() => undefined);
  };
  return current.kind === 'changed' ? (
    <ChangedKey key={current.promptId} prompt={current} onAnswer={answer} />
  ) : (
    <UnknownKey key={current.promptId} prompt={current} onAnswer={answer} />
  );
}

function endpoint(prompt: HostKeyPrompt): string {
  const host = prompt.host.includes(':') ? `[${prompt.host}]` : prompt.host;
  return `${host}:${prompt.port}`;
}

function purpose(prompt: HostKeyPrompt): string {
  const name = prompt.profileName === '' ? 'this connection' : `“${prompt.profileName}”`;
  return prompt.purpose === 'test' ? `testing ${name}` : `connecting to ${name}`;
}

function KeyLine(props: {
  readonly label: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{props.label}</span>
      <code
        className="font-mono text-[13px] break-all select-text"
        {...(props.testId ? { 'data-testid': props.testId } : {})}
      >
        {props.algorithm} {props.fingerprint}
      </code>
    </div>
  );
}

function UnknownKey(props: {
  readonly prompt: HostKeyPrompt;
  readonly onAnswer: (answer: HostKeyAnswer) => void;
}) {
  const { prompt, onAnswer } = props;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onAnswer('cancel')}
      title="Trust this SSH server?"
      width="w-[600px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onAnswer('cancel')}>
            Cancel
          </Button>
          <Button onClick={() => onAnswer('trust-once')}>Trust once</Button>
          <Button variant="primary" onClick={() => onAnswer('trust-remember')}>
            Trust and remember
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]" data-testid="host-key-prompt">
        <p>
          Joinery has not seen the SSH server <strong>{endpoint(prompt)}</strong> before (while{' '}
          {purpose(prompt)}). Connect only if this fingerprint is the one the server’s administrator
          gives you.
        </p>
        <div className="rounded border border-border bg-panel-2 p-3">
          <KeyLine
            label="Host key"
            algorithm={prompt.key.algorithm}
            fingerprint={prompt.key.fingerprintSha256}
            testId="host-key-fingerprint"
          />
        </div>
        <p className="text-xs text-muted">
          Trust once connects this time only. Trust and remember keeps the key in Joinery’s known
          hosts (shared with joinery-cli), so later connections check it without asking.
        </p>
      </div>
    </Modal>
  );
}

function ChangedKey(props: {
  readonly prompt: HostKeyPrompt;
  readonly onAnswer: (answer: HostKeyAnswer) => void;
}) {
  const { prompt, onAnswer } = props;
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && onAnswer('cancel')}
      title="Warning: the SSH host key has changed"
      width="w-[640px]"
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            disabled={!confirmed}
            onClick={() => onAnswer('forget-known')}
          >
            Remove the remembered key
          </Button>
          <Button variant="primary" autoFocus onClick={() => onAnswer('cancel')}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]" data-testid="host-key-changed">
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-danger/60 bg-danger/10 p-3 text-danger"
        >
          <Icon name="warning" className="mt-0.5" />
          <p>
            The SSH server <strong>{endpoint(prompt)}</strong> presented a different host key from
            the one Joinery remembered (while {purpose(prompt)}). Someone could be intercepting this
            connection (a man-in-the-middle attack), or the server was reinstalled. Joinery did not
            connect.
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded border border-border bg-panel-2 p-3">
          {prompt.known.map((key) => (
            <KeyLine
              key={key.fingerprintSha256}
              label="Remembered key"
              algorithm={key.algorithm}
              fingerprint={key.fingerprintSha256}
            />
          ))}
          <KeyLine
            label="Key presented now"
            algorithm={prompt.key.algorithm}
            fingerprint={prompt.key.fingerprintSha256}
            testId="host-key-fingerprint"
          />
        </div>
        <p>
          Ask the server’s administrator whether its host key changed. Only if they confirm it,
          remove the remembered key; Joinery then asks whether to trust the new one.
        </p>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          The administrator confirmed that the host key changed
        </label>
      </div>
    </Modal>
  );
}
