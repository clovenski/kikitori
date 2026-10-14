import { useEffect, useState } from 'react';

export interface TimeSource {
  getTimeMs(): number;
  seek(ms: number): void;
}

/** Polls a player for its current time. State only changes when the value does. */
export function useCurrentTime(source: TimeSource | null, intervalMs = 100): number {
  const [timeMs, setTimeMs] = useState(0);
  useEffect(() => {
    if (!source) {
      setTimeMs(0);
      return;
    }
    const id = setInterval(() => {
      try {
        const next = Math.round(source.getTimeMs());
        setTimeMs((prev) => (next === prev ? prev : next));
      } catch {
        /* the player is not ready yet */
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [source, intervalMs]);
  return timeMs;
}
