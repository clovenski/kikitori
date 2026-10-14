import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BgtApi, LibraryItem, ProgressEvent, Result, Submission } from '../../shared/ipc';

const ApiContext = createContext<BgtApi | null>(null);

export function ApiProvider({ api, children }: { api: BgtApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): BgtApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiProvider is missing');
  return api;
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function useQueue(): Submission[] {
  const api = useApi();
  const [subs, setSubs] = useState<Submission[]>([]);
  useEffect(() => {
    let alive = true;
    void api.queue.list().then((r) => {
      if (alive && r.ok) setSubs(r.value);
    });
    const off = api.queue.onChanged((next) => {
      if (alive) setSubs(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return subs;
}

export function useProgress(): Map<number, ProgressEvent> {
  const api = useApi();
  const [map, setMap] = useState<Map<number, ProgressEvent>>(new Map());
  useEffect(() => {
    return api.queue.onProgress(({ submissionId, event }) => {
      setMap((prev) => new Map(prev).set(submissionId, event));
    });
  }, [api]);
  return map;
}

/** Reloads the library whenever the queue changes (a job appears, finishes or gets translated). */
export function useLibrary(submissions: Submission[]): LibraryItem[] {
  const api = useApi();
  const [items, setItems] = useState<LibraryItem[]>([]);
  useEffect(() => {
    let alive = true;
    void api.library.list().then((r) => {
      if (alive && r.ok) setItems(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, submissions]);
  return items;
}
