# Milestone 2 Design: Translation and Summaries

Date: 2026-10-14
Status: Draft, awaiting review
Builds on: `2026-10-14-milestone-1-pipeline-design.md` (implemented and merged on `master`).

## 1. Intent

- **Outcome:** from the Japanese transcript segments already stored in SQLite, produce English subtitles (English-only and bilingual SRT) and a hierarchical, timestamped English summary. Local and free by default.
- **Who:** the author first (RTX 3080, 12 GB VRAM), later strangers on varied hardware.
- **Success criteria:**
  1. `bgt run <url> --translate --summarize` yields `job-N.en.srt`, `job-N.bi.srt` and `job-N.summary.md` for the two Milestone 1 test videos, and the author finds the English useful.
  2. A recurring name or term is rendered consistently across chunks (glossary works).
  3. Killing the process mid-translation and re-running resumes without re-translating finished batches.
  4. Whisper and the LLM never occupy VRAM at the same time.
  5. `--skim` produces a summary without a full translation.
- **Expectation setting:** a small local model translates Japanese stream talk worse than a cloud model (slang, names). The CLI output and the README (Milestone 6) say so.

## 2. Decisions

| Topic | Decision |
|---|---|
| LLM runtime | llama.cpp `llama-server`, downloaded and pinned via `tools.lock.json` like whisper.cpp. No Ollama support (YAGNI) |
| Client | One `LlmClient` speaking the OpenAI-compatible `/v1/chat/completions` API, so another endpoint (Gemini, later) is a config change |
| Translation model | Tencent Hy-MT2-7B, `Hy-MT2-7B-Q4_K_M.gguf` (Apache-2.0), from `tencent/Hy-MT2-7B-GGUF` |
| General model | A current Qwen3-8B-class instruct GGUF chosen at pin time from Hugging Face; used for glossary extraction and summaries |
| Model choice process | No bake-off. Defaults picked now, both are config values and can be swapped later |
| Summary source | English translation when it exists, otherwise the Japanese text (skim mode) |
| Gemini backend | Out of scope (stretch goal) |

## 3. Pipeline

Stages after transcription, each resumable. Each LLM stage starts its own model and stops it before the next stage, so only one model is in VRAM at a time. A full job: Whisper, then the general model (glossary), then Hy-MT2 (translate), then the general model (summarize).

1. **Glossary.** The general model reads the Japanese segments in windows of about 5 minutes and returns recurring names and terms with suggested English renderings (JSON). Results merge into one per-job glossary: first proposal wins, entries from the user's `--glossary` file always override.
2. **Translate.** Batches of about 25 segments. Each prompt uses Hy-MT2's documented terminology format (relevant glossary entries listed as "X translates to Y"), the previous 3 translated lines as context, and the batch as numbered lines. The reply must contain exactly one line per input line. A mismatching batch is retried (up to 2 retries), then translated line by line. A line that still fails is stored as an empty translation and logged, never as invented text.
3. **Summarize.** Windows of about 5 minutes with timestamps. The model writes 2 to 4 bullets per window, each tagged with the timestamp of the moment it describes. An overview is then written from the window summaries. If a job has more than 12 windows, an intermediate "section" level (groups of about 6 windows) is inserted automatically.
4. **Outputs**, rewritten after each completed batch or window:
   - `job-N.en.srt`: English only.
   - `job-N.bi.srt`: English on the first line, Japanese on the second.
   - `job-N.summary.md`: overview, then sections or windows with timestamped bullets.

Skim mode (`--skim`) runs glossary and summarize only; summaries read the Japanese text.

## 4. Components (all under `src/core/`, no Electron/React imports)

- `llm/llama-server.ts`: `LlamaServer` starts `llama-server` with a model and context size on a free local port, polls `/health`, exposes its base URL, and stops the process tree on `stop()` or abort.
- `llm/client.ts`: `LlmClient.chat(messages, opts)` returning text; handles retry on transient errors, abort, and timeouts.
- `llm/prompts.ts`: pure prompt builders for glossary extraction, translation (terminology, context, numbered lines) and summaries.
- `llm/parse.ts`: pure parsers for numbered-line replies and the glossary JSON, tolerant of stray text, code fences and `<think>` blocks.
- `backends/translate/hymt.ts`: `HyMtTranslator implements Translator` (batching, retry, fallback).
- `backends/summarize/llm.ts`: `LlmSummarizer implements Summarizer` (windows, overview, optional sections).
- `pipeline/translate-job.ts`, `pipeline/summarize-job.ts`, `pipeline/glossary-job.ts`: stage runners that read from and write to the repository and are resumable.
- `subtitles/bilingual.ts`: `toBilingualSrt`.
- `db`: migration 2 (see below).
- `cli`: new options and commands (see below).

The existing interfaces `Translator.translate(segments, glossary)` and `Summarizer.summarize(segments)` are used as declared in Milestone 1.

## 5. Storage (migration 2, `PRAGMA user_version = 2`)

- `glossary(job_id, ja TEXT, en TEXT, source TEXT)`, `source` in `auto | user`, unique on `(job_id, ja)`.
- `translations(job_id, segment_id INTEGER, text TEXT, batch_idx INTEGER)`, primary key `(job_id, segment_id)`; `segment_id` references `segments.id`.
- `summaries(job_id, level TEXT, idx INTEGER, start_ms, end_ms, text TEXT)`, `level` in `window | section | overview`.
- `stages(job_id, stage TEXT, status TEXT)`, `stage` in `glossary | translate | summarize`, `status` in `pending | running | done | failed`.

Segment ids are stable because segments are only replaced per chunk; translations of a re-transcribed chunk are dropped with their segments (cascade in the same transaction).

## 6. CLI

- `bgt run <source> ... [--translate] [--summarize] [--skim] [--glossary <file>]`
- `bgt translate <jobId> [--glossary <file>]` and `bgt summarize <jobId>` for finished jobs.
- `--glossary` file: JSON object mapping Japanese terms to English.
- Time estimates continue to print before each stage once a speed is known.

## 7. Tool fetching

`tools.lock.json` and `scripts/pin-tools.ts` gain: the llama.cpp Windows CUDA release asset (and, if that release ships the CUDA runtime as a separate zip, that zip), `Hy-MT2-7B-Q4_K_M.gguf`, and the general model GGUF. Checksums come from the Hugging Face tree API (LFS oid) and the GitHub release metadata, as in Milestone 1. `bgt doctor` reports the new binaries and models and whether `llama-server` can be launched.

## 8. Error handling

- New error codes: `LlmServerFailed` (server did not become healthy, with the last log lines) and `LlmFailed` (request failed after retries).
- A failed batch or window is retried, then marked failed; the stage continues; re-running processes only unfinished work.
- Ctrl+C aborts in-flight requests and stops `llama-server` before exiting.
- Output from the model that cannot be parsed never reaches the database.

## 9. Testing

- **Unit (no binaries):** prompt builders; parsers (numbered lines with missing, extra or merged lines; code fences; `<think>` blocks; glossary JSON); window splitting; bilingual SRT; glossary merge precedence; migration 2.
- **Stage tests with a fake LLM server** (a Node HTTP server speaking the chat API): translate resumes after an abort without redoing finished batches; a count-mismatch reply triggers retry then line-by-line fallback; an empty-transcript job translates and summarizes without error; summaries add a section level above 12 windows.
- **Server manager test** with a fake `llama-server` script: health polling, startup failure message, stop kills the tree.
- **Integration (opt-in, `BGT_INTEGRATION=1`):** real `llama-server` and models on a few Japanese lines.
- **Quality:** judged manually by the author on the two Milestone 1 test videos.

## 10. Out of scope

Gemini or any cloud backend, model bake-off, UI, SRT styling, VTT export, furigana, speaker labels, automatic glossary persistence across jobs.

## 11. Risks and open items

- Windows CUDA llama.cpp builds may ship CUDA runtime DLLs as a separate asset; handled at pin time.
- Hy-MT2's behavior with numbered-line batches on real subtitle text is untested; the retry and line-by-line fallback exist for this.
- Glossary extraction quality from a general 8B model is unproven and the most likely thing to need tuning.
- The general model may emit reasoning blocks; parsers strip them and prompts request none.
- Loading a 7B model per stage costs a few seconds to tens of seconds; acceptable for the job sizes involved.
