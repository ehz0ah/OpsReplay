import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NativeSelect,
  NumberInput,
  Stack,
  TextInput,
} from '@mantine/core';
import { Clock3, ArrowUpRight } from 'lucide-react';
import type { OperationOffer, SessionView } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';
import { useWriter } from '../api/mutations.js';
import { duration, humanize } from './common.js';

type Field = {
  name: string;
  type: string;
  fixed?: string | number;
  options?: string[];
  min?: number;
  max?: number;
  required: boolean;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unsupported operation schema.');
  return value as Record<string, unknown>;
}
function fieldsFor(offer: OperationOffer): Field[] {
  const properties = object(offer.argumentSchema.properties);
  const required = Array.isArray(offer.argumentSchema.required)
    ? offer.argumentSchema.required
    : [];
  return Object.entries(properties).map(([name, value]) => {
    const field = object(value);
    return {
      name,
      type: String(field.type),
      required: required.includes(name),
      ...(typeof field.const === 'string' || typeof field.const === 'number'
        ? { fixed: field.const }
        : {}),
      ...(Array.isArray(field.enum) ? { options: field.enum.map(String) } : {}),
      ...(typeof field.minimum === 'number' ? { min: field.minimum } : {}),
      ...(typeof field.maximum === 'number' ? { max: field.maximum } : {}),
    };
  });
}
export function ActionForm({
  offer,
  session,
  onClose,
}: {
  offer: OperationOffer;
  session: SessionView;
  onClose: () => void;
}) {
  const { busy, submit } = useWriter();
  const [fields] = useState(() => fieldsFor(offer));
  const [values, setValues] = useState<Record<string, string | number>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.name,
        field.fixed ??
          (field.type === 'integer'
            ? field.name === 'windowTicks'
              ? Math.min(10, field.max ?? 10)
              : (field.min ?? 1)
            : field.required
              ? (field.options?.[0] ?? '')
              : ''),
      ]),
    ),
  );
  const [expectedVersion] = useState(session.version);
  const [error, setError] = useState('');
  const cost = offer.costFromArgument ? Number(values[offer.costFromArgument]) : offer.costTicks;
  function apply() {
    const args = Object.fromEntries(
      fields
        .filter((field) => field.required || values[field.name] !== '')
        .map((field) => [field.name, values[field.name]]),
    );
    const result = validatePublic('Command', { tool: offer.tool, arguments: args });
    if (!result.ok) {
      setError('Check the action parameters. All required values must be valid.');
      return;
    }
    submit({
      kind: 'action',
      label: offer.label,
      sessionId: session.id,
      body: {
        requestId: crypto.randomUUID(),
        expectedVersion,
        source: 'direct',
        command: result.value,
      },
    });
    onClose();
  }
  return (
    <Modal
      opened
      onClose={onClose}
      title={offer.requiresConfirmation ? 'Confirm mitigation' : offer.label}
      centered
      size="md"
      transitionProps={{ duration: 0 }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <Stack gap="lg">
          {offer.requiresConfirmation && (
            <div>
              <h3>{offer.label}</h3>
              <p className="muted">
                This changes the simulated system. Review the target and parameters before
                continuing.
              </p>
            </div>
          )}
          {fields.map((field) =>
            field.fixed !== undefined ? (
              <div className="parameter" key={field.name}>
                <span>
                  {field.name === 'targetVersion' ? 'Target version' : humanize(field.name)}
                </span>
                <code>{field.fixed}</code>
              </div>
            ) : field.type === 'integer' ? (
              <NumberInput<number>
                key={field.name}
                label={
                  field.name === 'windowTicks'
                    ? 'Lookback window'
                    : field.name === 'ticks'
                      ? 'Advance by'
                      : humanize(field.name)
                }
                description={
                  field.name.toLowerCase().includes('tick')
                    ? 'Each step represents ' + duration(1, session.tickSeconds) + '.'
                    : undefined
                }
                required={field.required}
                {...(field.min === undefined ? {} : { min: field.min })}
                {...(field.max === undefined ? {} : { max: field.max })}
                allowDecimal={false}
                hideControls
                value={values[field.name] ?? ''}
                onChange={(value) => setValues({ ...values, [field.name]: value })}
              />
            ) : field.options ? (
              <NativeSelect
                key={field.name}
                label={
                  field.name === 'windowTicks'
                    ? 'Lookback window'
                    : field.name === 'ticks'
                      ? 'Advance by'
                      : humanize(field.name)
                }
                required={field.required}
                data={field.required ? field.options : ['', ...field.options]}
                value={values[field.name]}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.currentTarget.value })
                }
              />
            ) : (
              <TextInput
                key={field.name}
                label={
                  field.name === 'windowTicks'
                    ? 'Lookback window'
                    : field.name === 'ticks'
                      ? 'Advance by'
                      : humanize(field.name)
                }
                required={field.required}
                value={values[field.name]}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.currentTarget.value })
                }
              />
            ),
          )}
          <div className="time-cost">
            <Clock3 size={16} aria-hidden="true" />
            Uses {Number.isFinite(cost) ? duration(cost, session.tickSeconds) : '…'} of simulated
            time
          </div>
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} data-autofocus>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} rightSection={<ArrowUpRight size={16} />}>
              {offer.requiresConfirmation
                ? 'Confirm action'
                : offer.tool === 'advance_time'
                  ? 'Advance time'
                  : 'Inspect'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
