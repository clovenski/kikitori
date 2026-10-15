// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { installDropGuard } from '../../src/app/renderer/lib/dropguard';

const fire = (target: EventTarget, type: string) => {
  const event = new Event(type, { cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('installDropGuard', () => {
  it('cancels dragover and drop anywhere so a dropped file never navigates the window', () => {
    const off = installDropGuard(document);
    expect(fire(document.body, 'dragover')).toBe(true);
    expect(fire(document.body, 'drop')).toBe(true);
    off();
  });

  it('stops cancelling once removed', () => {
    const off = installDropGuard(document);
    off();
    expect(fire(document.body, 'drop')).toBe(false);
  });
});
