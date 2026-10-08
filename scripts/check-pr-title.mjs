import { pathToFileURL } from 'node:url';

export const allowedPullRequestTypes = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'test',
  'chore',
  'ci',
  'build',
  'perf',
  'revert',
];

const type = `(?:${allowedPullRequestTypes.join('|')})`;
const scope = String.raw`(?:\([a-z0-9]+(?:[./-][a-z0-9]+)*\))?`;
const titlePattern = new RegExp(String.raw`^${type}${scope}!?: \S(?:[^\r\n]*\S)?$`);

export function validatePullRequestTitle(title) {
  if (typeof title === 'string' && titlePattern.test(title)) return null;

  return (
    'Use "type(scope): summary" with an optional scope and optional !. ' +
    `Allowed types: ${allowedPullRequestTypes.join(', ')}.`
  );
}

function main() {
  const error = validatePullRequestTitle(process.env.PR_TITLE);
  if (!error) return;

  console.error(error);
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
