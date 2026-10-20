import { readFile } from 'node:fs/promises';
import { repeatScenarios } from './scenarios.js';
import { runLoad } from './load.js';
import { assistantConfiguration, benchmarkAssistant, type BenchmarkCase } from './assistant.js';
const [mode, input, output, execute, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || execute !== '--run' || extra.length) throw new Error('Use MODE INPUT OUTPUT.json --run.');
  let passed: boolean;
  if (mode === 'scenarios') {
    const [challenge, repeats, ...rest] = input.split(':');
    if (rest.length || !repeats || !/^[0-9]+$/.test(repeats)) throw new Error('Use CHALLENGE:REPEATS.');
    passed = await repeatScenarios(challenge as 'wrong-upstream-port' | 'stale-dns-record', Number(repeats), output);
  } else {
    const bytes = await readFile(input);
    if (bytes.length > 256 * 1024) throw new Error('Configuration exceeds bound.');
    const config = JSON.parse(bytes.toString());
    if (mode === 'load') passed = await runLoad(config, output);
    else if (mode === 'assistant') {
      const cases = JSON.parse(
        await readFile(new URL('./assistant-cases.json', import.meta.url), 'utf8'),
      ) as BenchmarkCase[];
      passed = await benchmarkAssistant(assistantConfiguration(config), cases, output);
    } else throw new Error('Select scenarios, load or assistant.');
  }
  console.log(
    passed
      ? 'Evaluation run completed. Review the saved report.'
      : 'Evaluation stopped or failed. Review the saved report.',
  );
  if (!passed) process.exitCode = 1;
} catch {
  console.error('Evaluation failed. Check arguments, private configuration, bounds and report path.');
  process.exitCode = 1;
}
