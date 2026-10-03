import {
  completionTarget,
  keywordCaseSetting,
  loadQualifierDatabase,
  snippetsFor,
} from '../state/autocomplete';
import { toCompletionList, toSignatureHelp } from './completion-mapping';
import { languageClient } from './language';
import { monaco } from './monaco';

/**
 * Querybara's SQL language service in Monaco (spec §6): a completion provider and a signature help
 * provider per dialect's language (pgsql; mysql for MySQL and MariaDB). Each request is for the
 * query tab that owns the model, so two tabs on different connections complete from their own
 * catalogs, in their own session context. The work happens in the language worker; Monaco's
 * cancellation token cancels a request that is still waiting there.
 */

/** Model URI → the query tab it belongs to. */
const tabs = new Map<string, string>();

/** Ties an editor model to its query tab, for completion. */
export function bindModel(model: monaco.editor.ITextModel, tabId: string): void {
  tabs.set(model.uri.toString(), tabId);
}

export function unbindModel(model: monaco.editor.ITextModel): void {
  tabs.delete(model.uri.toString());
}

function signalOf(token: monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

const MAX_ITEMS = 500;

const completionProvider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['.', ' ', '(', '"', '`'],
  async provideCompletionItems(model, position, context, token) {
    const tabId = tabs.get(model.uri.toString());
    const target = tabId === undefined ? undefined : completionTarget(tabId);
    if (!target) return undefined;
    const signal = signalOf(token);
    const offset = model.getOffsetAt(position);
    const text = model.getValue();
    const [snippets] = await Promise.all([
      snippetsFor(target.dialect),
      loadQualifierDatabase(target, text.slice(0, offset)),
    ]);
    if (signal.aborted || model.isDisposed()) return undefined;
    const result = await languageClient.complete(
      {
        channel: model.uri.toString(),
        profileId: target.profileId,
        context: target.context,
        text,
        offset,
        snippets,
        keywordCase: keywordCaseSetting(),
        maxItems: MAX_ITEMS,
      },
      signal,
    );
    if (!result || signal.aborted || model.isDisposed()) return undefined;
    return toCompletionList(result, model, position, monaco.languages, context.triggerCharacter);
  },
};

const signatureProvider: monaco.languages.SignatureHelpProvider = {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [','],
  async provideSignatureHelp(model, position, token) {
    const tabId = tabs.get(model.uri.toString());
    const target = tabId === undefined ? undefined : completionTarget(tabId);
    if (!target) return undefined;
    const help = await languageClient.signatureHelp(
      {
        channel: model.uri.toString(),
        profileId: target.profileId,
        context: target.context,
        text: model.getValue(),
        offset: model.getOffsetAt(position),
      },
      signalOf(token),
    );
    if (!help || model.isDisposed()) return undefined;
    return { value: toSignatureHelp(help), dispose: () => {} };
  },
};

let registered = false;

/** Registers the providers once for both SQL languages. */
export function registerSqlLanguage(): void {
  if (registered) return;
  registered = true;
  for (const language of ['pgsql', 'mysql']) {
    monaco.languages.registerCompletionItemProvider(language, completionProvider);
    monaco.languages.registerSignatureHelpProvider(language, signatureProvider);
  }
}
