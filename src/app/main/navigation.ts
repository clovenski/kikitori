/**
 * True only for the app's own page. Anything else (a dropped file, a web page) must not replace the UI:
 * a dropped .html would run with the preload bridge attached.
 */
export function isAllowedNavigation(url: string, appUrl: string): boolean {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    return target.protocol === app.protocol && target.host === app.host && target.pathname === app.pathname;
  } catch {
    return false;
  }
}
