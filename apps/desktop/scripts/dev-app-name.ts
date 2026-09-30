import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * A development run (`pnpm dev`) starts Electron's own app bundle from node_modules, so macOS
 * names the application menu, the Dock tile and the app switcher "Electron". This gives that
 * bundle the app's product name, as a packaged build has (electron-builder writes it into
 * Info.plist). macOS only, and only when the name differs. The bundle is ad-hoc signed without
 * a sealed Info.plist, so the change needs no new signature.
 */

if (process.platform === 'darwin') {
  const appDir = join(import.meta.dirname, '..');
  const { productName } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    productName: string;
  };
  // `electron` resolves to the path of the bundle's executable (Contents/MacOS/Electron).
  const executable = createRequire(join(appDir, 'package.json'))('electron') as string;
  const plist = join(dirname(executable), '..', 'Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const current = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
    if (current !== productName) {
      execFileSync('plutil', ['-replace', key, '-string', productName, plist]);
    }
  }
}
