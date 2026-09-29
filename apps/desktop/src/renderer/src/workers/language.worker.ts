import { LanguageService, type LanguageRequest, type LanguageResponse } from './language-service';

/**
 * The editor's language worker (spec §6): the language service on its own thread, so parsing
 * and completion never block typing. The renderer talks to it through `lib/language`.
 */

const service = new LanguageService((response: LanguageResponse) => self.postMessage(response));

self.addEventListener('message', (event: MessageEvent<LanguageRequest>) => {
  service.handle(event.data);
});
