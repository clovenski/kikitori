import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {} }));
const { appMenuTemplate } = await import('../../src/app/main/menu');

describe('appMenuTemplate', () => {
  it('gives Windows and Linux no menu at all', () => {
    expect(appMenuTemplate('win32')).toBeNull();
    expect(appMenuTemplate('linux')).toBeNull();
  });

  it('gives macOS an app menu and an Edit menu, so Quit and copy/paste work', () => {
    const template = appMenuTemplate('darwin') ?? [];
    expect(template[0]).toEqual({ role: 'appMenu' });
    const edit = template.find((item) => item.label === 'Edit');
    const roles = (edit?.submenu as { role?: string }[]).map((item) => item.role);
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo']));
  });

  it('keeps Reload and DevTools out of the packaged macOS menu', () => {
    expect(JSON.stringify(appMenuTemplate('darwin'))).not.toMatch(/reload|toggleDevTools|viewMenu/i);
  });
});
