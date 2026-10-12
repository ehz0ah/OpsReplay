export interface HintPlanItem {
  id: string;
  minElapsedMinutes: number;
}

const hintId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isHintPlan(value: unknown): value is HintPlanItem[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (item, index) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).length === 2 &&
        Object.hasOwn(item, 'id') &&
        typeof item.id === 'string' &&
        item.id.length <= 60 &&
        hintId.test(item.id) &&
        Object.hasOwn(item, 'minElapsedMinutes') &&
        Number.isInteger(item.minElapsedMinutes) &&
        (item.minElapsedMinutes as number) >= 0 &&
        (item.minElapsedMinutes as number) <= 120 &&
        (index === 0 || (value[index - 1] as HintPlanItem).minElapsedMinutes <= (item.minElapsedMinutes as number)),
    ) &&
    new Set(value.map((item) => (item as HintPlanItem).id)).size === value.length
  );
}

export function hintAvailableAt(readyAt: string, minElapsedMinutes: number): string {
  const ready = Date.parse(readyAt);
  if (
    !Number.isFinite(ready) ||
    !Number.isInteger(minElapsedMinutes) ||
    minElapsedMinutes < 0 ||
    minElapsedMinutes > 120
  )
    throw new Error('Invalid hint availability.');
  return new Date(ready + minElapsedMinutes * 60_000).toISOString();
}
