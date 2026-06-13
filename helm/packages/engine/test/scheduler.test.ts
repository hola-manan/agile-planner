import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFields,
  quadrantOf,
  slotTypeOf,
  solve,
  sprintCapacityHours,
  Sprint,
  Task,
  TaskJudgement,
} from '../src/index';

const TODAY = '2026-06-13';

function task(id: string, j: TaskJudgement, over: Partial<Task> = {}): Task {
  const d = deriveFields(j, TODAY);
  return {
    id,
    listId: 'L1',
    sublistId: null,
    title: id,
    status: 'backlog',
    slotsDone: 0,
    dependsOn: [],
    createdAt: Date.parse(TODAY + 'T00:00:00Z'),
    updatedAt: Date.parse(TODAY + 'T00:00:00Z'),
    ...d,
    ...over,
  };
}

const sprint: Sprint = {
  id: 'S1',
  number: 1,
  startDate: '2026-06-13',
  endDate: '2026-06-19',
  status: 'active',
  capacityDays: 5, // 5 days * 9h = 45h capacity
  leaveDays: [],
  createdAt: 0,
};

test('quadrant placement follows importance x urgency', () => {
  assert.equal(quadrantOf(5, 5), 'Q1');
  assert.equal(quadrantOf(5, 1), 'Q2');
  assert.equal(quadrantOf(1, 5), 'Q3');
  assert.equal(quadrantOf(1, 1), 'Q4');
});

test('slot type: big important work is deep, low importance is maintenance', () => {
  assert.equal(slotTypeOf(5, 'L'), 'deep');
  assert.equal(slotTypeOf(5, 'XS'), 'important'); // important but tiny -> 1h slot
  assert.equal(slotTypeOf(2, 'L'), 'maintenance');
});

test('deriveFields splits a 6h deep task into two deep slots', () => {
  const d = deriveFields({ importance: 5, complexity: 'L' }, TODAY); // L = 6h, deep slot = 3h
  assert.equal(d.slotType, 'deep');
  assert.equal(d.estHours, 6);
  assert.equal(d.slots, 2);
});

test('capacity subtracts leave days', () => {
  assert.equal(sprintCapacityHours(sprint), 45);
  assert.equal(sprintCapacityHours({ ...sprint, leaveDays: ['2026-06-16'] }), 36);
});

test('solve commits high priority first and overflows the rest to backlog', () => {
  // Two huge deep tasks (12h each via two... XL=12h, deep slot 3h => 4 slots, 12h)
  const big1 = task('big1', { importance: 5, complexity: 'XL', timeSensitivity: 5 });
  const big2 = task('big2', { importance: 4, complexity: 'XL', timeSensitivity: 1 });
  const big3 = task('big3', { importance: 5, complexity: 'XL', timeSensitivity: 5 });
  // 3 * 12h = 36h fits in 45h... add a fourth to force overflow
  const big4 = task('big4', { importance: 3, complexity: 'XL', timeSensitivity: 1 });

  const r = solve({ tasks: [big1, big2, big3, big4], sprint, today: TODAY });
  const committedHours = r.committed.reduce((s, t) => s + t.estHours, 0);
  assert.ok(committedHours <= 45, 'never commits beyond capacity');
  assert.ok(r.backlog.length >= 1, 'lowest-priority work overflows');
  // The least important (big4, Q? importance 3 not urgent) should be the one dropped.
  assert.ok(r.backlog.some((t) => t.id === 'big4'));
  assert.ok(r.alerts.some((a) => a.kind === 'over_capacity'));
});

test("today's plan respects the 3-3-3 shape", () => {
  const deep = task('deep', { importance: 5, complexity: 'M' }); // 1 deep slot
  const imp1 = task('imp1', { importance: 4, complexity: 'S' });
  const imp2 = task('imp2', { importance: 3, complexity: 'S' });
  const maint = task('maint', { importance: 1, complexity: 'S' });

  const r = solve({ tasks: [deep, imp1, imp2, maint], sprint, today: TODAY });
  const deepSlots = r.today.slots.filter((s) => s.type === 'deep');
  const impSlots = r.today.slots.filter((s) => s.type === 'important');
  const maintSlots = r.today.slots.filter((s) => s.type === 'maintenance');

  assert.equal(deepSlots.length, 1);
  assert.equal(deepSlots[0].taskId, 'deep');
  assert.equal(deepSlots[0].hours, 3);
  assert.ok(impSlots.length >= 2);
  assert.equal(maintSlots[0].taskId, 'maint');
});

test('blocked tasks leave the active plan and raise an alert', () => {
  const a = task('a', { importance: 5, complexity: 'M' });
  const b = task('b', { importance: 5, complexity: 'M' }, { status: 'blocked', blocker: 'waiting on API key' });
  const r = solve({ tasks: [a, b], sprint, today: TODAY });
  assert.ok(!r.today.slots.some((s) => s.taskId === 'b'));
  assert.ok(r.alerts.some((al) => al.kind === 'blocked' && al.taskIds.includes('b')));
});

test('dependencies gate scheduling', () => {
  const base = task('base', { importance: 5, complexity: 'M' }, { status: 'backlog' });
  const dependent = task('dep', { importance: 5, complexity: 'M' }, { dependsOn: ['base'] });
  const r = solve({ tasks: [base, dependent], sprint, today: TODAY });
  // dep is not ready (base not done) -> not placed today
  assert.ok(!r.today.slots.some((s) => s.taskId === 'dep'));
});
