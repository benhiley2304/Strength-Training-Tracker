import test from 'node:test';
import assert from 'node:assert/strict';
import {sessions, workoutExercise, exerciseFor} from '../programme.js';
import {freshState, newDraft, changeExercise, upgradeDraftProgramme, completedSets, validateState, estimate, clone, migrateLegacy} from '../model.js';
import {reconcile, sameState, ReconcileError} from '../sync-merge.js';

const filled = {kg: '80', reps: '4', rpe: '8', done: true};
function fixture() {
  const state = freshState(); state.profiles = [state.profiles[0]];
  const p = state.profiles[0]; p.drafts[1] = newDraft(p);
  return {state, p, d: p.drafts[1]};
}
test('Upper A has one row movement and the pull-up / OHP second pair at every intensity', () => {
  for (const s of sessions.filter(s => s.key === 'UA')) {
    assert.deepEqual(s.ex.slice(0, 4).map(e => e.name), ['Bench Press', 'Barbell Row', 'Weighted Pull-up', 'Barbell Overhead Press']);
    assert.equal(s.ex.filter(e => /row/i.test(e.name)).length, 1);
    assert.equal(s.ex[2].body, 1);
  }
});
test('retired movements remain in the catalogue and legacy entered rows keep their labels', () => {
  const {state, d} = fixture();
  d.exercises[2].name = 'Incline Dumbbell Press';
  d.exercises[3].name = 'Dumbbell Row';
  d.exercises[3].sets[0] = {...filled};
  assert.doesNotThrow(() => validateState(state));
  upgradeDraftProgramme(d);
  assert.equal(d.exercises[2].name, 'Weighted Pull-up');
  assert.equal(d.exercises[3].name, 'Dumbbell Row');
  assert.equal(completedSets(d)[0].exercise, 'Dumbbell Row');
  assert.ok(exerciseFor('Incline Dumbbell Press'));
});
test('blank substitution is per-workout, persists through validation, and does not alter the programme', () => {
  const {state, p, d} = fixture();
  assert.equal(changeExercise(d, 0, 'Machine Chest Press'), true);
  p.exerciseSchemaVersion = 1;
  assert.equal(validateState(state).profiles[0].drafts[1].exercises[0].name, 'Machine Chest Press');
  assert.equal(sessions[0].ex[0].name, 'Bench Press');
  assert.equal(newDraft(p).exercises[0].name, 'Bench Press');
  assert.ok(d.exercises[0].sets.every(s => !s.done && s.kg === ''));
});
test('completed and entered-but-unticked original sets are retained without weight transfer', () => {
  const {d} = fixture();
  d.exercises[0].sets[0] = {...filled};
  d.exercises[0].sets[1] = {...filled, kg: '75', done: false};
  changeExercise(d, 0, 'Weighted Pull-up');
  assert.equal(d.exercises[0].sets[0].exercise, 'Bench Press');
  assert.equal(d.exercises[0].sets[1].exercise, 'Bench Press');
  assert.equal(d.exercises[0].sets[2].kg, '');
  assert.equal(workoutExercise(d, 0, d.exercises[0].sets[0]).body, false);
  assert.equal(workoutExercise(d, 0, d.exercises[0].sets[2]).body, true);
  assert.deepEqual(completedSets(d).map(s => s.exercise), ['Bench Press']);
  Object.assign(d.exercises[0].sets[2], {kg: '0', reps: '8', rpe: '7', done: true});
  const sets = completedSets(d);
  assert.deepEqual(sets.map(s => s.exercise), ['Bench Press', 'Weighted Pull-up']);
  assert.equal(sets[1].body, true);
  assert.ok(estimate(sets[1], 80) > 0);
});
test('repeated swaps and restore keep actual set identities', () => {
  const {state, d} = fixture();
  d.exercises[0].sets[0] = {...filled};
  changeExercise(d, 0, 'Machine Chest Press');
  Object.assign(d.exercises[0].sets[1], {kg: '50', reps: '6', rpe: '', done: true});
  changeExercise(d, 0, 'Bench Press');
  assert.equal(d.exercises[0].originalName, undefined);
  assert.deepEqual(completedSets(d).map(s => s.exercise), ['Bench Press', 'Machine Chest Press']);
  assert.doesNotThrow(() => validateState(state));
});
test('custom names are supported, safely bounded and never receive invented strength estimates', () => {
  const {state, d} = fixture();
  changeExercise(d, 0, 'My cable press');
  d.exercises[0].sets[0] = {...filled};
  const set = completedSets(d)[0];
  assert.equal(set.exercise, 'My cable press');
  assert.equal(estimate(set, 80), null);
  assert.doesNotThrow(() => validateState(state));
  assert.throws(() => changeExercise(d, 0, 'x'.repeat(81)), /name/);
  assert.throws(() => changeExercise(d, 99, 'Bench Press'), /name/);
});
test('custom and retained mobility rows use their actual validation and history type', () => {
  const {state, d} = fixture();
  changeExercise(d, 0, 'Spinal Decompression');
  d.exercises[0].sets[0].done = true;
  changeExercise(d, 0, 'Machine Chest Press');
  assert.doesNotThrow(() => validateState(state));
  assert.equal(completedSets(d)[0].mobility, true);
  assert.equal(completedSets(d)[0].exercise, 'Spinal Decompression');
});
test('an empty substitution is meaningful for sync and merges with an independent note edit', () => {
  const {state} = fixture(), local = clone(state), remote = clone(state);
  changeExercise(local.profiles[0].drafts[1], 0, 'Machine Chest Press');
  remote.profiles[0].drafts[1].notes = 'Other device note';
  assert.equal(sameState(local, state), false);
  const merged = reconcile(state, local, remote);
  assert.equal(merged.profiles[0].drafts[1].exercises[0].name, 'Machine Chest Press');
  assert.equal(merged.profiles[0].drafts[1].notes, 'Other device note');
});
test('simultaneous swap and original-movement logging cannot silently relabel a remote set', () => {
  const {state} = fixture(), local = clone(state), remote = clone(state);
  changeExercise(local.profiles[0].drafts[1], 0, 'Weighted Pull-up');
  remote.profiles[0].drafts[1].exercises[0].sets[0] = {...filled};
  assert.throws(() => reconcile(state, local, remote), ReconcileError);
});
test('legacy V2 draft migration never labels old DB rows or presses as the corrected pair', () => {
  const migrated = migrateLegacy({strengthTrainingTrackerV2: {
    current: 1, done: [], bw: 80, history: [], notes: {}, conditioning: {},
    drafts: {'1-2': [{...filled}], '1-3': [{...filled}]}
  }});
  const d = migrated.profiles[0].drafts[1];
  assert.equal(d.exercises[2].name, 'Incline Dumbbell Press');
  assert.equal(d.exercises[3].name, 'Dumbbell Row');
  assert.doesNotThrow(() => validateState(migrated));
});
