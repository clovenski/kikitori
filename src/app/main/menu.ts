import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

/**
 * The production menu. Windows gets none; macOS cannot go without one, because its app menu owns Quit
 * and its Edit menu is what makes copy/paste work in text fields.
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
}

/** Only `dev:app` keeps Electron's default menu (it carries Reload and Toggle DevTools); preview and installer builds get the real one. */
export function applyAppMenu(production: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!production) return;
  const template = appMenuTemplate(platform);
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}
