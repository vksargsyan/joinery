import { contextBridge, ipcRenderer } from 'electron';

import {
  HELLO_CHANNEL,
  PORT_CHANNEL,
  isPortPayload,
  toPortMessage,
  type JoineryBridge,
} from '../shared/bridge';

/**
 * Preload (spec §3, §18): sandboxed, context-isolated, bundled to one CommonJS file. It exposes
 * `window.joinery` and forwards MessagePorts from main into the page. Ports cannot cross
 * contextBridge, so each one is re-posted to the page's own window with a fixed message shape
 * (ADR 0004); the page checks source, origin and shape before using it.
 */

const bridge: JoineryBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions['electron'] ?? '',
    chrome: process.versions['chrome'] ?? '',
    node: process.versions.node,
  },
  requestMainPort: () => ipcRenderer.send(HELLO_CHANNEL),
};

contextBridge.exposeInMainWorld('joinery', bridge);

ipcRenderer.on(PORT_CHANNEL, (event, payload: unknown) => {
  const [port, ...extra] = event.ports;
  if (!port || extra.length > 0 || !isPortPayload(payload)) {
    for (const p of event.ports) p.close();
    return;
  }
  window.postMessage(toPortMessage(payload), window.location.origin, [port]);
});
