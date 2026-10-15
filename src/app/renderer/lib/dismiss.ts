import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';

// Open dialogs, oldest first. Only the last one (the one on top) answers Escape.
const open: symbol[] = [];

/** Closes a dialog on Escape. When dialogs are stacked, only the topmost one closes. */
export function useEscapeToClose(onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const id = Symbol('dialog');
    open.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || open[open.length - 1] !== id) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      open.splice(open.indexOf(id), 1);
    };
  }, []);
}

/** Backdrop handler that closes on a press outside the dialog (a press that starts inside and drags out does not count). */
export function closeOnBackdrop(onClose: () => void) {
  return (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
}
