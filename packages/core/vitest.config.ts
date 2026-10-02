import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Schedules are local time: the tests run in a zone with daylight saving, so its gaps and
    // repeated hours are exercised wherever they run.
    env: { TZ: 'Europe/Berlin' },
    pool: 'forks',
  },
});
