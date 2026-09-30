import { bytesKey, utf8Bytes } from '@joinery/redis-tools';
import { useEffect, useState } from 'react';

import { errorMessage } from '../../../lib/errors';
import { WRITE } from '../../../../../shared/redis-safety';
import { redisWrite } from '../../../state/redis/panels';
import { Button, Input } from '../../ui';
import { Notice, Toolbar, usePanelData } from '../common';
import { useValueEditor } from '../ValueEditorPanel';

/**
 * The RedisJSON document editor (spec §10): the document (or the value at a JSONPath) as
 * pretty JSON, saved with JSON.SET at the same path. JSONPath answers are arrays of matches;
 * a single match on "$" is shown (and saved) as the document itself.
 */

/** The editor text for a JSON.GET answer at `path`. */
export function jsonEditorText(json: string, path: string): string {
  const value: unknown = JSON.parse(json);
  const unwrapped = path === '$' && Array.isArray(value) && value.length === 1 ? value[0] : value;
  return JSON.stringify(unwrapped, null, 2);
}

export function JsonEditor() {
  const editor = useValueEditor();
  const [path, setPath] = useState('$');
  const [applied, setApplied] = useState('$');
  const doc = usePanelData(
    editor.panelId,
    (host, sessionId) => host.redis.json.get({ sessionId, key: editor.key, path: applied }),
    [bytesKey(editor.key), applied],
  );
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const json = doc.data?.json;
    if (json === undefined || json === null) return;
    try {
      setText(jsonEditorText(json, applied));
    } catch {
      setText(json);
    }
    setDirty(false);
  }, [doc.data, applied]);

  const save = async (): Promise<void> => {
    setError(undefined);
    let compact: string;
    try {
      compact = JSON.stringify(JSON.parse(text));
    } catch (e) {
      setError(`Invalid JSON: ${errorMessage(e)}`);
      return;
    }
    try {
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Save the document?',
        commands: [[utf8Bytes('JSON.SET'), editor.key, utf8Bytes(applied), utf8Bytes(compact)]],
        confirmLabel: 'Save',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.json.set({
              sessionId,
              key: editor.key,
              path: applied,
              json: compact,
              confirmed,
            }),
          ),
      });
      if (!done) return;
      editor.changed();
      await doc.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="json-editor">
      <Toolbar label="JSON document">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(path.trim() || '$');
          }}
        >
          <Input
            aria-label="JSONPath"
            className="h-7 w-64 font-mono text-xs"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button size="sm" type="submit">
            Go
          </Button>
        </form>
        <span className="flex-1" />
        <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </Toolbar>
      {(error ?? doc.error) && <Notice kind="error">{error ?? doc.error}</Notice>}
      <textarea
        aria-label="JSON document"
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-[13px] text-fg focus:outline-none"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
    </div>
  );
}
