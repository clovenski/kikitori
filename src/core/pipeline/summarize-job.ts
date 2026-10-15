import type { Repo } from '../db/repo';
import type { StageRepo, SummaryRow } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import { rollupMessages, windowSummaryMessages } from '../llm/prompts';
import { renderWindow, splitWindows } from '../llm/windows';
import type { ProgressEvent } from '../progress';

const SECTION_THRESHOLD = 12;
const SECTION_SIZE = 6;

export async function runSummarizeStage(a: {
  repo: Repo;
  stages: StageRepo;
  llm: LlmChat;
  jobId: number;
  rangeStartMs: number;
  signal?: AbortSignal;
  log: (message: string) => void;
  progress?: (e: ProgressEvent) => void;
}): Promise<void> {
  const { repo, stages, llm, jobId, rangeStartMs, signal, log } = a;
  if (stages.getStage(jobId, 'summarize') === 'done') return;
  stages.setStage(jobId, 'summarize', 'running');

  const translations = stages.listTranslations(jobId);
  const language = stages.getStage(jobId, 'translate') === 'done' ? 'en' : 'ja';
  const glossary = stages.listGlossary(jobId);
  const segments = repo.listSegmentsWithId(jobId).map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    text: translations.get(s.id) || s.text,
  }));
  const windows = splitWindows(segments);

  const have = (level: SummaryRow['level']) => new Map(stages.listSummaries(jobId, level).map((r) => [r.idx, r]));
  const windowRows = have('window');
  let incomplete = false;

  for (const window of windows) {
    signal?.throwIfAborted();
    if (windowRows.has(window.idx)) {
      a.progress?.({ stage: 'summarize', done: window.idx + 1, total: windows.length, message: 'Summarizing' });
      continue;
    }
    log(`Summarizing window ${window.idx + 1}/${windows.length}`);
    try {
      const text = await llm.chat(
        windowSummaryMessages({ text: renderWindow(window, rangeStartMs), language, glossary }),
        { signal, maxTokens: 600 },
      );
      signal?.throwIfAborted(); // never persist work finished after an abort
      const row: SummaryRow = {
        level: 'window',
        idx: window.idx,
        startMs: window.startMs + rangeStartMs,
        endMs: window.endMs + rangeStartMs,
        text,
      };
      stages.saveSummary(jobId, row);
      windowRows.set(window.idx, row);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Summary: skipped window ${window.idx + 1}: ${err instanceof Error ? err.message : err}`);
      incomplete = true;
    }
    a.progress?.({ stage: 'summarize', done: window.idx + 1, total: windows.length, message: 'Summarizing' });
  }
  if (incomplete) {
    // Do not build sections or the overview from a partial set; the next run fills the gaps first.
    log('Summary: some windows failed. Re-run "kikitori summarize" to retry them.');
    stages.setStage(jobId, 'summarize', 'failed');
    return;
  }

  const windowList = [...windowRows.values()].sort((x, y) => x.idx - y.idx);
  let rollupSource = windowList;

  if (windows.length > SECTION_THRESHOLD) {
    const sectionRows = have('section');
    for (let g = 0; g * SECTION_SIZE < windowList.length; g++) {
      signal?.throwIfAborted();
      const group = windowList.slice(g * SECTION_SIZE, (g + 1) * SECTION_SIZE);
      if (!sectionRows.has(g)) {
        try {
          const text = await llm.chat(rollupMessages({ kind: 'section', items: group.map((r) => r.text).join('\n') }), {
            signal,
            maxTokens: 600,
          });
          signal?.throwIfAborted();
          sectionRows.set(g, {
            level: 'section',
            idx: g,
            startMs: group[0].startMs,
            endMs: group[group.length - 1].endMs,
            text,
          });
          stages.saveSummary(jobId, sectionRows.get(g) as SummaryRow);
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          log(`Summary: skipped section ${g + 1}: ${err instanceof Error ? err.message : err}`);
          incomplete = true;
        }
      }
    }
    rollupSource = [...sectionRows.values()].sort((x, y) => x.idx - y.idx);
  }

  if (!incomplete && rollupSource.length > 0 && !have('overview').has(0)) {
    signal?.throwIfAborted();
    try {
      const text = await llm.chat(rollupMessages({ kind: 'overview', items: rollupSource.map((r) => r.text).join('\n') }), {
        signal,
        maxTokens: 400,
      });
      signal?.throwIfAborted();
      stages.saveSummary(jobId, {
        level: 'overview',
        idx: 0,
        startMs: windowList[0].startMs,
        endMs: windowList[windowList.length - 1].endMs,
        text,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Summary: could not write the overview: ${err instanceof Error ? err.message : err}`);
      incomplete = true;
    }
  }
  stages.setStage(jobId, 'summarize', incomplete ? 'failed' : 'done');
}
