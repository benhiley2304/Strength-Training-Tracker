import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEditBuffer, newHistoryEditRow, buildEditedSession, localDateInput} from '../history-edit.js';
import {clone, estimate, newProfile, APP} from '../model.js';
import {reconcile, ReconcileError} from '../sync-merge.js';

function saved() {
  return {id: 'saved-yesterday', date: '2026-09-15T18:00:23.000Z', session: 1, cycle: 1,
    name: 'Heavy Upper A', startedAt: Date.parse('2026-09-15T17:00:23.000Z'), durationSeconds: 3600,
    bwSnapshot: 80, readiness: {energy: 4, sleep: 3, joints: 5}, notes: 'Original notes', conditioning: 'None', partial: false,
    sets: [
      {exercise: 'Dumbbell Row', set: 1, kg: 20, reps: 8, rpe: 8, done: true, compound: false, body: false, mobility: false},
      {exercise: 'Incline Dumbbell Press', set: 1, kg: 50, reps: 8, rpe: 8, done: true, compound: false, body: false, mobility: false},
      {exercise: 'Dumbbell Row', set: 2, kg: 22, reps: 8, rpe: 9, done: true, compound: false, body: false, mobility: false}
    ]};
}
test('edit buffer is independent; cancelling it cannot mutate the saved record', () => {
  const original = saved(), before = clone(original), edit = sessionEditBuffer(original);
  edit.groups[0].name = 'Weighted Pull-up'; edit.groups[0].sets[0].kg = '10'; edit.notes = 'Cancelled';
  assert.deepEqual(original, before);
});
test('renaming saved exercise groups retains values and recalculates correct exercise metadata', () => {
  const original = saved(), edit = sessionEditBuffer(original);
  edit.groups[0].name = 'Weighted Pull-up'; edit.groups[1].name = 'Barbell Overhead Press';
  const result = buildEditedSession(original, edit);
  assert.equal(result.id, original.id); assert.equal(result.session, original.session); assert.equal(result.cycle, original.cycle);
  assert.deepEqual(result.sets.map(s => s.exercise), ['Weighted Pull-up', 'Barbell Overhead Press', 'Weighted Pull-up']);
  assert.deepEqual(result.sets.map(s => s.kg), [20, 50, 22]);
  assert.equal(result.sets[0].body, true); assert.equal(result.sets[1].body, false);
  assert.ok(estimate(result.sets[0], result.bwSnapshot) > 0);
  assert.ok(result.editedAt);
});
test('note-only corrections preserve exact date, duration and original set ordering', () => {
  const original = saved(), edit = sessionEditBuffer(original); edit.notes = 'Corrected note';
  const result = buildEditedSession(original, edit);
  assert.equal(result.date, original.date); assert.equal(result.durationSeconds, 3600); assert.equal(result.startedAt, original.startedAt);
  assert.deepEqual(result.sets.map(s => s.exercise), original.sets.map(s => s.exercise));
});
test('set additions, removals and corrections keep stable identities and never duplicate the workout', () => {
  const original = saved(), edit = sessionEditBuffer(original);
  edit.groups[0].sets.splice(1, 1);
  edit.groups[0].sets[0].reps = '9';
  const added = newHistoryEditRow(); Object.assign(added, {kg: '24', reps: '6', rpe: ''}); edit.groups[0].sets.push(added);
  const result = buildEditedSession(original, edit);
  assert.equal(result.sets.length, 3); assert.equal(new Set(result.sets.map(s => s.id)).size, 3);
  assert.equal(result.sets[0].reps, 9); assert.equal(result.sets[2].kg, 24);
  assert.equal(result.id, original.id);
});
test('invalid or empty sets and invalid exercise names cannot replace a saved session', () => {
  const original = saved();
  for (const [field, value] of [['kg', ''], ['kg', '-1'], ['reps', '0'], ['reps', '1.5'], ['rpe', '11']]) {
    const edit = sessionEditBuffer(original); edit.groups[0].sets[0][field] = value;
    assert.throws(() => buildEditedSession(original, edit));
  }
  const empty = sessionEditBuffer(original); empty.groups = [];
  assert.throws(() => buildEditedSession(original, empty), /at least one/);
  const unnamed = sessionEditBuffer(original); unnamed.groups[0].name = '';
  assert.throws(() => buildEditedSession(original, unnamed));
});
test('date and duration corrections preserve a sensible start time and reject future dates', () => {
  const original = saved(), edit = sessionEditBuffer(original);
  edit.date = localDateInput('2026-09-14T17:00:00.000Z'); edit.minutes = '45';
  const result = buildEditedSession(original, edit, Date.parse('2026-09-16T10:00:00.000Z'));
  assert.equal(result.durationSeconds, 2700); assert.equal(Date.parse(result.date) - result.startedAt, 2700000);
  edit.date = '2099-01-01T12:00';
  assert.throws(() => buildEditedSession(original, edit), /date/);
});
test('legacy completion evidence is not fabricated by an edit', () => {
  const original = saved(); original.legacy = true; original.sets.forEach(s => { s.done = false; s.legacyRecorded = true; delete s.mobility; });
  const edit = sessionEditBuffer(original); edit.notes = 'Changed'; edit.partial = 'false';
  const result = buildEditedSession(original, edit);
  assert.ok(result.legacy); assert.ok(result.sets.every(s => !s.done && s.legacyRecorded));
  assert.ok(result.sets.every(s => !Object.hasOwn(s, 'mobility')));
});
test('history edits merge with independent active-workout settings without changing the current session', () => {
  const p = newProfile('Test', 'test'); p.current = 4; p.history = [saved()];
  const base = {app: APP, version: 3, revision: 0, activeProfileId: 'test', theme: 'light', profiles: [p]};
  const local = clone(base), remote = clone(base);
  const edit = sessionEditBuffer(local.profiles[0].history[0]); edit.notes = 'History correction';
  local.profiles[0].history[0] = buildEditedSession(local.profiles[0].history[0], edit);
  remote.profiles[0].restSeconds = 120;
  const merged = reconcile(base, local, remote);
  assert.equal(merged.profiles[0].current, 4); assert.equal(merged.profiles[0].restSeconds, 120);
  assert.equal(merged.profiles[0].history.length, 1); assert.equal(merged.profiles[0].history[0].notes, 'History correction');
});
test('concurrent set reassignment and logging cannot silently change exercise identities', () => {
  const p = newProfile('Test', 'test'); p.history = [saved()];
  const base = {app: APP, version: 3, revision: 0, activeProfileId: 'test', theme: 'light', profiles: [p]};
  const local = clone(base), remote = clone(base);
  const edit = sessionEditBuffer(p.history[0]); edit.groups[0].name = 'Weighted Pull-up';
  local.profiles[0].history[0] = buildEditedSession(p.history[0], edit);
  remote.profiles[0].history[0].sets[0].kg = 26;
  assert.throws(() => reconcile(base, local, remote), ReconcileError);
});
test('renaming a session title merges with an independent set correction without a false exercise conflict', () => {
  const p = newProfile('Test', 'test'); p.history = [saved()];
  const base = {app: APP, version: 3, revision: 0, activeProfileId: 'test', theme: 'light', profiles: [p]};
  const local = clone(base), remote = clone(base);
  const edit = sessionEditBuffer(p.history[0]); edit.name = 'Upper A corrected';
  local.profiles[0].history[0] = buildEditedSession(p.history[0], edit);
  remote.profiles[0].history[0].sets[0].kg = 26;
  const merged = reconcile(base, local, remote);
  assert.equal(merged.profiles[0].history[0].name, 'Upper A corrected');
  assert.equal(merged.profiles[0].history[0].sets[0].kg, 26);
});
