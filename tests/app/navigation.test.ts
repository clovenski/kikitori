import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAllowedNavigation } from '../../src/app/main/navigation';

const appUrl = pathToFileURL('C:/Users/Joel/source/repos/bg-auto-translator/out/renderer/index.html').toString();

describe('isAllowedNavigation', () => {
  it('allows only the app page itself (a hash or query change stays on the page)', () => {
    expect(isAllowedNavigation(appUrl, appUrl)).toBe(true);
    expect(isAllowedNavigation(`${appUrl}#/job/1`, appUrl)).toBe(true);
    expect(isAllowedNavigation(`${appUrl}?x=1`, appUrl)).toBe(true);
  });

  it('refuses any other file, so a stray drop cannot replace the app', () => {
    const dropped = pathToFileURL('C:/Users/Joel/Downloads/some video.mp4').toString();
    expect(isAllowedNavigation(dropped, appUrl)).toBe(false);
    expect(isAllowedNavigation(pathToFileURL('C:/evil/page.html').toString(), appUrl)).toBe(false);
  });

  it('refuses web pages and malformed URLs', () => {
    expect(isAllowedNavigation('https://example.com/', appUrl)).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', appUrl)).toBe(false);
    expect(isAllowedNavigation('not a url', appUrl)).toBe(false);
  });

  it('in development allows the dev server page and nothing else on the web', () => {
    const dev = 'http://localhost:5173/';
    expect(isAllowedNavigation('http://localhost:5173/', dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:5173/#/x', dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:9999/', dev)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', dev)).toBe(false);
  });
});
