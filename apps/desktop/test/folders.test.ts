import { describe, expect, it } from 'vitest';

import { nextFolderName } from '../src/renderer/src/state/folders';

/** New folders of the connection tree: "Folder N", never a name already taken. */

describe('nextFolderName', () => {
  it('counts on from the folders there are', () => {
    expect(nextFolderName([])).toBe('Folder 1');
    expect(nextFolderName([{ name: 'Staging' }])).toBe('Folder 2');
  });

  it('skips a name already taken, whatever its case', () => {
    expect(nextFolderName([{ name: 'folder 2' }])).toBe('Folder 3');
    expect(nextFolderName([{ name: 'Folder 2' }, { name: 'Folder 3' }])).toBe('Folder 4');
  });
});
