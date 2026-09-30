import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The local store runs on node:sqlite; its ExperimentalWarning is noise in test output.
    execArgv: ['--no-warnings=ExperimentalWarning'],
    // Several tests seal and unseal secrets with production-cost scrypt (about 0.4 s and 128 MB
    // per derivation), which a fully parallel workspace run can push past the 5 s default.
    testTimeout: 30_000,
  },
});
