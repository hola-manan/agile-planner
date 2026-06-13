import { SlotConfig, Sprint, DEFAULT_SLOT_CONFIG } from './types';

/** Total focused hours a single working day provides under the 3-3-3 shape. */
export function hoursPerDay(cfg: SlotConfig = DEFAULT_SLOT_CONFIG): number {
  return (
    cfg.deepCount * cfg.deepHours +
    cfg.importantCount * cfg.importantHours +
    cfg.maintenanceCount * cfg.maintenanceHours
  );
}

/** Effective working days after subtracting leave from the sprint capacity. */
export function effectiveDays(sprint: Sprint): number {
  const leave = new Set(sprint.leaveDays ?? []);
  return Math.max(0, sprint.capacityDays - leave.size);
}

/** Total committable hours in a sprint = effective days × hours/day. */
export function sprintCapacityHours(
  sprint: Sprint,
  cfg: SlotConfig = DEFAULT_SLOT_CONFIG,
): number {
  return effectiveDays(sprint) * hoursPerDay(cfg);
}

/** Inclusive list of YYYY-MM-DD dates between start and end. */
export function datesInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let d = Date.parse(startDate + 'T00:00:00Z');
  const end = Date.parse(endDate + 'T00:00:00Z');
  if (Number.isNaN(d) || Number.isNaN(end)) return out;
  while (d <= end) {
    out.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  return out;
}
