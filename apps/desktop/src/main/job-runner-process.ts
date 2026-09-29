import { utilityProcess } from 'electron';

import type { JobRunnerFactory } from './jobs';

/**
 * Starts the job runner as an Electron utility process running the `job-runner` bundle. Like a
 * connection host it gets no command-line arguments: jobs and their resolved profiles arrive
 * over the parent port.
 */
export function utilityJobRunnerFactory(modulePath: string): JobRunnerFactory {
  return (label) => {
    const child = utilityProcess.fork(modulePath, [], { serviceName: label });
    return {
      send: (message) => child.postMessage(message),
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
