import { Command } from 'commander';
import { updateYtDlp } from '../core/tools/ytdlp';
import { resolveTool } from '../core/tools/paths';
import { BgtError } from '../core/errors';
import { doctorCommand } from './doctor';
import { llmCommand } from './llm';
import { runCommand } from './run';

const program = new Command();
program.name('kikitori').description('Transcribe Japanese YouTube videos locally with whisper.cpp');

program
  .command('run')
  .argument('<source>', 'YouTube URL or path to a local audio/video file')
  .option('--start <time>', 'start of the section (S, M:SS or H:MM:SS)')
  .option('--end <time>', 'end of the section')
  .option('--model <name>', 'whisper model name (ggml-<name>.bin); default: the one for the installed tier')
  .option('--out <dir>', 'output directory', 'output')
  .option('--max-minutes <n>', 'maximum minutes of audio per job', '30')
  .option('--keep-work', 'keep intermediate files in data/work')
  .option('--translate', 'translate to English (Hy-MT2) after transcribing')
  .option('--summarize', 'write a timestamped English summary')
  .option('--skim', 'summarize without a full translation (cannot be combined with --translate)')
  .option('--glossary <file>', 'JSON file mapping Japanese terms to English')
  .action(runCommand);

program
  .command('translate')
  .argument('<jobId>', 'id of a finished job')
  .option('--glossary <file>', 'JSON file mapping Japanese terms to English')
  .option('--summarize', 'also write a summary')
  .option('--out <dir>', 'output directory', 'output')
  .action((jobId, o) => llmCommand(jobId, o, 'translate'));

program
  .command('summarize')
  .argument('<jobId>', 'id of a finished job')
  .option('--out <dir>', 'output directory', 'output')
  .action((jobId, o) => llmCommand(jobId, o, 'summarize'));

program.command('doctor').description('Check that all required tools and models are available').action(doctorCommand);

program
  .command('update-ytdlp')
  .description('Update yt-dlp (needed whenever YouTube changes)')
  .action(async () => {
    try {
      console.log(await updateYtDlp(resolveTool('yt-dlp')));
    } catch (err) {
      if (err instanceof BgtError) {
        console.error(`${err.code}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
