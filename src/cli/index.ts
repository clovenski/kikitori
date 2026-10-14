import { Command } from 'commander';
import { updateYtDlp } from '../core/tools/ytdlp';
import { resolveTool } from '../core/tools/paths';
import { BgtError } from '../core/errors';
import { doctorCommand } from './doctor';
import { runCommand } from './run';

const program = new Command();
program.name('bgt').description('Transcribe Japanese YouTube videos locally with whisper.cpp');

program
  .command('run')
  .argument('<source>', 'YouTube URL or path to a local audio/video file')
  .option('--start <time>', 'start of the section (S, M:SS or H:MM:SS)')
  .option('--end <time>', 'end of the section')
  .option('--model <name>', 'whisper model name (ggml-<name>.bin)', 'large-v3')
  .option('--out <dir>', 'output directory', 'output')
  .option('--max-minutes <n>', 'maximum minutes of audio per job', '30')
  .option('--keep-work', 'keep intermediate files in data/work')
  .action(runCommand);

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
