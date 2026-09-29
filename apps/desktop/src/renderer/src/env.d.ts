/// <reference types="vite/client" />

import type { JoineryBridge } from '../../shared/bridge';

declare global {
  interface Window {
    readonly joinery: JoineryBridge;
  }
}
