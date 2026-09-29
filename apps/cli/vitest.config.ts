import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The local store runs on node:sqlite; its ExperimentalWarning is noise in test output.
    execArgv: ['--no-warnings=ExperimentalWarning'],
  },
});
