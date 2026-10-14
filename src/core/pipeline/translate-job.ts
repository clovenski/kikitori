import type { BatchTranslator } from '../backends/translate/hymt';
import type { Repo } from '../db/repo';
import type { StageRepo } from '../db/stage-repo';

export async function runTranslateStage(a: {
  repo: Repo;
  stages: StageRepo;
  translator: BatchTranslator;
  jobId: number;
  batchSize?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
  onBatch?: () => void;
}): Promise<void> {
  const { repo, stages, translator, jobId, signal, log } = a;
  if (stages.getStage(jobId, 'translate') === 'done') return;
  stages.setStage(jobId, 'translate', 'running');

  const batchSize = a.batchSize ?? 25;
  const segments = repo.listSegmentsWithId(jobId);
  const translated = stages.listTranslations(jobId);
  const glossary = stages.listGlossary(jobId);
  const pending = segments.filter((s) => (translated.get(s.id) ?? '') === '');
  const totalBatches = Math.ceil(pending.length / batchSize);

  for (let i = 0, batchIdx = 0; i < pending.length; i += batchSize, batchIdx++) {
    signal?.throwIfAborted();
    const batch = pending.slice(i, i + batchSize);
    const first = segments.findIndex((s) => s.id === batch[0].id);
    const context = segments
      .slice(Math.max(0, first - 3), first)
      .map((s) => translated.get(s.id) ?? '')
      .filter((t) => t !== '');

    log(`Translating batch ${batchIdx + 1}/${totalBatches} (${batch.length} lines)`);
    const out = await translator.translateBatch(
      batch.map((s) => s.text),
      glossary,
      context,
      signal,
    );
    const items = batch.map((s, k) => ({ segmentId: s.id, text: out[k] ?? '' }));
    stages.saveTranslations(jobId, batchIdx, items);
    for (const item of items) translated.set(item.segmentId, item.text);
    const blank = items.filter((item) => item.text === '').length;
    if (blank > 0) log(`Translation: ${blank} line${blank === 1 ? '' : 's'} in this batch could not be translated and were left blank.`);
    a.onBatch?.();
  }
  const stillBlank = segments.filter((s) => (translated.get(s.id) ?? '') === '').length;
  if (stillBlank > 0) {
    log(`Translation: ${stillBlank} line${stillBlank === 1 ? '' : 's'} could not be translated. Re-run "bgt translate" to retry them.`);
  }
  stages.setStage(jobId, 'translate', stillBlank > 0 ? 'failed' : 'done');
}
