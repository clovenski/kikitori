import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BgtApi, ChannelInfo, FeedItem, LibraryItem, ProgressEvent, Result, SetupProgress, SetupState, Submission, UpdateState } from '../../shared/ipc';

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

export function useSetupState(): { state: SetupState | null; refresh(): void } {
  const api = useApi();
  const [state, setState] = useState<SetupState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.setup.state().then((r) => {
      if (alive && r.ok) setState(r.value);
    });
    return () => {
      alive = false;
    };
  }, [api, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { state, refresh };
}

const IDLE: SetupProgress = { phase: 'idle', progress: null, message: null };

/** The latest progress report of the background setup (it keeps running when a dialog closes). */
export function useSetupProgress(): SetupProgress {
  const api = useApi();
  const [progress, setProgress] = useState<SetupProgress>(IDLE);
  useEffect(() => api.setup.onProgress(setProgress), [api]);
  return progress;
}

/** Followed channels and their feed; reloads on `channels:changed` and whenever the queue changes (a new job links a video). */
export function useChannels(submissions: Submission[]): { channels: ChannelInfo[]; feed: FeedItem[]; reload(): void } {
  const api = useApi();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.channels.list(), api.channels.feed()]).then(([c, f]) => {
      if (!alive) return;
      if (c.ok) setChannels(c.value);
      if (f.ok) setFeed(f.value);
    });
    return () => {
      alive = false;
    };
  }, [api, tick, submissions]);
  useEffect(() => api.channels.onChanged(() => setTick((t) => t + 1)), [api]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { channels, feed, reload };
}

const NO_UPDATE: UpdateState = { phase: 'idle' };

/** The app update's state; it changes when a check finds a version and while one downloads. */
export function useUpdateState(): UpdateState {
  const api = useApi();
  const [state, setState] = useState<UpdateState>(NO_UPDATE);
  useEffect(() => {
    let alive = true;
    void api.updates.state().then((r) => {
      if (alive && r.ok) setState(r.value);
    });
    const off = api.updates.onChanged((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return state;
}
