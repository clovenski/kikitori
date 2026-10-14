import type { Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';
import type { LlmChat } from '../llm/client';
import { parseGlossaryJson } from '../llm/parse';
import { glossaryMessages } from '../llm/prompts';
import { splitWindows } from '../llm/windows';

export async function runGlossaryStage(a: {
  repo: Repo;
  stages: StageRepo;
  llm: LlmChat;
  jobId: number;
  userGlossary: Record<string, string>;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<void> {
  const { repo, stages, llm, jobId, signal, log } = a;
  // User entries always apply, even when the model pass already ran earlier.
  stages.upsertGlossary(
    jobId,
    Object.entries(a.userGlossary).map(([ja, en]) => ({ ja, en, source: 'user' as const })),
  );
  if (stages.getStage(jobId, 'glossary') === 'done') return;

  stages.setStage(jobId, 'glossary', 'running');
  const windows = splitWindows(repo.listSegments(jobId));
  for (const window of windows) {
    signal?.throwIfAborted();
    try {
      const reply = await llm.chat(glossaryMessages(window.segments.map((s) => s.text).join('\n')), {
        signal,
        maxTokens: 1024,
      });
      signal?.throwIfAborted(); // never persist work finished after an abort
      stages.upsertGlossary(
        jobId,
        parseGlossaryJson(reply).map((item) => ({ ...item, source: 'auto' as const })),
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log(`Glossary: skipped window ${window.idx + 1}/${windows.length}: ${err instanceof Error ? err.message : err}`);
    }
  }
  stages.setStage(jobId, 'glossary', 'done');
}
