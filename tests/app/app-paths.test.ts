import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/app/main/app-paths';

const base = {
  appPath: 'C:/proj',
  resourcesPath: 'C:/Program Files/App/resources',
  appData: 'C:/Users/me/AppData/Roaming',
  documents: 'C:/Users/me/Documents',
};

describe('resolveAppPaths', () => {
  it('development keeps the project folders', () => {
    expect(resolveAppPaths({ ...base, packaged: false, env: {} })).toEqual({
      projectRoot: 'C:/proj',
      resourcesDir: path.join('C:/proj', 'resources'),
      dataDir: path.join('C:/proj', 'data'),
      outDir: path.join('C:/proj', 'output'),
      userData: null,
    });
  });

  it('a packaged app keeps tools and data in AppData, subtitles in Documents, and the lock file next to the app', () => {
    const p = resolveAppPaths({ ...base, packaged: true, env: {} });
    const profile = path.join(base.appData, 'BG Auto Translator');
    expect(p).toEqual({
      projectRoot: base.resourcesPath,
      resourcesDir: path.join(profile, 'resources'),
      dataDir: path.join(profile, 'data'),
      outDir: path.join(base.documents, 'BG Auto Translator'),
      userData: profile,
    });
  });

  it('BGT_USER_DATA moves everything, including the output, into one folder (empty-profile testing)', () => {
    const p = resolveAppPaths({ ...base, packaged: true, env: { BGT_USER_DATA: 'D:/profile' } });
    expect(p.resourcesDir).toBe(path.join('D:/profile', 'resources'));
    expect(p.outDir).toBe(path.join('D:/profile', 'output'));
    expect(p.userData).toBe('D:/profile');
    const dev = resolveAppPaths({ ...base, packaged: false, env: { BGT_USER_DATA: 'D:/profile' } });
    expect(dev.projectRoot).toBe('C:/proj');
    expect(dev.dataDir).toBe(path.join('D:/profile', 'data'));
  });

  it('the individual BGT_* variables still win', () => {
    const p = resolveAppPaths({
      ...base,
      packaged: true,
      env: { BGT_PROJECT_ROOT: 'X', BGT_RESOURCES_DIR: 'R', BGT_DATA_DIR: 'D', BGT_OUTPUT_DIR: 'O' },
    });
    expect([p.projectRoot, p.resourcesDir, p.dataDir, p.outDir]).toEqual(['X', 'R', 'D', 'O']);
  });
});
