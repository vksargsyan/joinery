import { utilityProcess, type MessagePortMain } from 'electron';

import type { HostProcessFactory } from './host-process';

/**
 * Starts connection hosts as Electron utility processes running the `connection-host` bundle.
 * The host inherits the environment but gets no command-line arguments; everything it needs
 * arrives over the parent port.
 */
export function utilityHostFactory(modulePath: string): HostProcessFactory<MessagePortMain> {
  return (label) => {
    const child = utilityProcess.fork(modulePath, [], { serviceName: label });
    return {
      send: (message, ports) => child.postMessage(message, ports ? [...ports] : undefined),
      onMessage: (listener) => {
        child.on('message', listener);
      },
      onExit: (listener) => {
        child.on('exit', (code) => listener(code));
      },
      kill: () => {
        child.kill();
      },
    };
  };
}
