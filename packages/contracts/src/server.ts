import scenarioSchema from '../schemas/scenario.schema.json' with { type: 'json' };
import registry from '../tools.json' with { type: 'json' };
import type { Scenario } from './generated/scenario.js';
import type { Command } from './generated/public.js';
import { createValidator, issuesFrom } from './validator.js';
import type { ValidationResult } from './validator.js';

const validate = createValidator().compile<Scenario>(scenarioSchema);

export function validateScenarioShape(value: unknown): ValidationResult<Scenario> {
  return validate(value) ? { ok: true, value } : { ok: false, issues: issuesFrom(validate.errors) };
}

export function getTool(name: Command['tool']) {
  const tool = registry.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool definition: ${name}`);
  // Callers may narrow schemas for a scenario, but cannot alter the registry.
  return structuredClone(tool);
}
