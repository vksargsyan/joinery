/// <reference types="vite/client" />

import type { QuerybaraBridge } from '../../shared/bridge';

declare global {
  interface Window {
    readonly querybara: QuerybaraBridge;
  }
}
