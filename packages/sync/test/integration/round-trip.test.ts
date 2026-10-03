import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { configuredServers } from './helpers';
import { describeServer, loadCases, roundTrip, skipReason } from './structure';

/**
 * The round-trip invariant (spec §13 step 8, §20) against real servers, for every golden case
 * with SQL fixtures (see structure.ts for the steps).
 *
 * PostgreSQL cases run on QUERYBARA_TEST_POSTGRES_URL. MySQL-family cases run on
 * QUERYBARA_TEST_MYSQL_URL and QUERYBARA_TEST_MARIADB_URL, both databases on the same server; a
 * case that needs a feature the server lacks is skipped with the reason in its title.
 */

const cases = loadCases(fileURLToPath(new URL('../golden', import.meta.url)));
const infos = await Promise.all(configuredServers().map(describeServer));

describe('structure round trip', () => {
  it('has SQL fixtures for both engine families', () => {
    expect(cases.filter((c) => c.family === 'postgres').length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => c.family === 'mysql').length).toBeGreaterThanOrEqual(10);
  });

  if (infos.length === 0) it.skip('no QUERYBARA_TEST_*_URL is set', () => undefined);

  for (const info of infos) {
    const family = info.server.engine === 'postgres' ? 'postgres' : 'mysql';
    describe(`${info.server.engine} ${info.banner}`, () => {
      for (const testCase of cases.filter((c) => c.family === family)) {
        const reason = skipReason(testCase, info);
        if (reason !== undefined) {
          it.skip(`${testCase.name} (skipped: ${reason})`, () => undefined);
          continue;
        }
        it(testCase.name, async () => {
          await roundTrip(testCase, info);
        });
      }
    });
  }
});
