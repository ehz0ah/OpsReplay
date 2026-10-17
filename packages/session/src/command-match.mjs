// Keep authored whole-line matches. Extend them only to plain, sequential command
// lists. Shell text and combined output do not prove that a simple command ran.
function sequentialCommands(text) {
  const commands = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (quote === '"' && (character === '`' || (character === '$' && text[index + 1] === '('))) return [];
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ';') {
      commands.push(text.slice(start, index).trim());
      start = index + 1;
    } else if ('\r\n&|(){}<>`#$'.includes(character)) return [];
  }
  if (quote || escaped || commands.length === 0) return [];
  commands.push(text.slice(start).trim());
  // A trailing semicolon is valid. Empty interior commands and shell control
  // words are outside this extension, as are executable names built by quoting.
  if (commands.at(-1) === '') commands.pop();
  const control =
    /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|time|coproc|exit|return|exec|break|continue)\b/;
  if (commands.some((command) => !/^[A-Za-z0-9_./-]+(?:\s|$)/.test(command) || control.test(command))) return [];
  return commands;
}

export function matchesCommand(patterns, text) {
  const expressions = patterns.map((source) => new RegExp(source));
  if (expressions.some((expression) => expression.test(text))) return true;
  return sequentialCommands(text).some((command) => expressions.some((expression) => expression.test(command)));
}
