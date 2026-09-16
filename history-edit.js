import {APP, clone, newProfile, uid, validateState} from './model.js';
import {exerciseFor, validExerciseName} from './programme.js';

export function localDateInput(value) {
  const date = new Date(value);
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function sessionEditBuffer(session) {
  const groups = [];
  session.sets.forEach((set, index) => {
    let group = groups.find(g => g.originalName === set.exercise);
    if (!group) {
      group = {key: `g${groups.length}`, name: set.exercise, originalName: set.exercise, sets: []};
      groups.push(group);
    }
    group.sets.push({key: `s${index}`, sourceIndex: index, source: clone(set),
      kg: String(set.kg), reps: String(set.reps), rpe: set.rpe === null ? '' : String(set.rpe)});
  });
  return {name: session.name, date: localDateInput(session.date), notes: session.notes,
    conditioning: session.conditioning, bw: session.bwSnapshot === null ? '' : String(session.bwSnapshot),
    minutes: session.durationSeconds === null ? '' : (session.durationSeconds / 60).toFixed(1),
    partial: String(session.partial), readiness: Object.fromEntries(Object.entries(session.readiness).map(([k, v]) => [k, v === null ? '' : String(v)])),
    groups};
}
export function newHistoryEditRow() {
  return {key: uid(), sourceIndex: null, source: null, kg: '', reps: '', rpe: ''};
}
/** Build a replacement for ONE existing record; its stable ID and cycle/session IDs never change. */
export function buildEditedSession(original, edit, now = Date.now()) {
  const initial = sessionEditBuffer(original), updated = clone(original);
  if (typeof edit.name !== 'string' || !edit.name.trim() || edit.name.trim().length > 160) throw new Error('Enter a session name.');
  updated.name = edit.name.trim();
  if (edit.date !== initial.date) {
    const date = new Date(edit.date);
    if (!Number.isFinite(+date) || localDateInput(date) !== edit.date || +date > now + 300000) throw new Error('Choose a valid past or current session date and time.');
    updated.date = date.toISOString();
  }
  if (edit.minutes !== initial.minutes) {
    if (edit.minutes === '') { updated.durationSeconds = null; updated.startedAt = null; }
    else {
      const minutes = Number(edit.minutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 144000000) throw new Error('Enter a valid session duration, or leave it blank.');
      updated.durationSeconds = Math.round(minutes * 60);
      updated.startedAt = Math.max(0, Date.parse(updated.date) - updated.durationSeconds * 1000);
    }
  } else if (updated.date !== original.date && updated.startedAt !== null) {
    updated.startedAt += Date.parse(updated.date) - Date.parse(original.date);
  }
  updated.bwSnapshot = edit.bw === '' ? null : Number(edit.bw);
  updated.notes = edit.notes; updated.conditioning = edit.conditioning;
  updated.partial = original.legacy ? original.partial : edit.partial === 'true';
  updated.readiness = Object.fromEntries(['energy', 'sleep', 'joints'].map(k => [k, edit.readiness[k] === '' ? null : Number(edit.readiness[k])]));
  const editRows = edit.groups.flatMap(group => group.sets);
  const structuralChange = editRows.length !== original.sets.length || editRows.some(row => row.sourceIndex === null) || new Set(editRows.map(row => row.sourceIndex)).size !== original.sets.length;
  const rows = [];
  const seenSources = new Set();
  for (const group of edit.groups) {
    const typed = group.name.trim().replace(/\s+/g, ' ');
    const unchangedName = typed === group.originalName;
    if (!(unchangedName && typed.length <= 160) && !validExerciseName(typed)) throw new Error('Choose or enter a valid exercise name (up to 80 characters for a new name).');
    if (!typed) throw new Error('Every exercise needs a name.');
    const name = unchangedName ? typed : exerciseFor(typed)?.name || typed;
    const definition = exerciseFor(name), mobility = definition?.cat === 'Mobility';
    group.sets.forEach((row, index) => {
      if (row.kg.trim() === '' || row.reps.trim() === '') throw new Error(`Enter kg and reps for every ${name} set, or remove the empty set.`);
      const kg = Number(row.kg), reps = Number(row.reps), rpe = row.rpe === '' ? null : Number(row.rpe);
      if (mobility && (kg !== 0 || reps !== 0)) throw new Error(`${name} is activity-only. Use 0 kg and 0 reps, or choose a resistance exercise.`);
      if (!mobility && (kg < 0 || kg > 1500 || !Number.isFinite(kg) || !Number.isInteger(reps) || reps < 1 || reps > 200)) throw new Error(`Check the kg and reps for ${name}.`);
      if (rpe !== null && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10 || (rpe * 2) % 1)) throw new Error('RPE must be 1–10 in half-point steps, or blank.');
      const sourceIndex = row.sourceIndex;
      if (sourceIndex !== null && (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= original.sets.length || seenSources.has(sourceIndex))) throw new Error('A set identity changed. Reopen this session before saving.');
      if (sourceIndex !== null) seenSources.add(sourceIndex);
      const previous = sourceIndex === null ? null : original.sets[sourceIndex];
      const identity = previous?.id || (structuralChange ? sourceIndex === null ? `new-${row.key}` : `${original.id}:set:${sourceIndex}` : null);
      const set = {...(previous || {}), ...(identity ? {id: identity} : {}),
        exercise: name, set: previous?.set || Math.min(index + 1, 100), kg, reps, rpe,
        done: previous ? previous.done : true,
        ...(previous && unchangedName ? {} : {compound: !!definition?.compound, body: !!definition?.body, mobility})};
      // Editing an old import does not fabricate proof that its sets were ticked complete.
      if (previous?.legacyRecorded) set.legacyRecorded = true;
      rows.push({order: sourceIndex === null ? original.sets.length + rows.length : sourceIndex, set});
    });
  }
  if (original.sets.length && !rows.length) throw new Error('Keep at least one set in this session. Cancel to retain the original.');
  if (rows.length > 1200) throw new Error('A session can contain at most 1,200 sets.');
  updated.sets = rows.sort((a, b) => a.order - b.order).map(r => r.set);
  updated.editedAt = new Date(now).toISOString();
  const checkProfile = newProfile('Validation', 'history-edit-check'); checkProfile.history = [updated];
  validateState({app: APP, version: 3, revision: 0, activeProfileId: checkProfile.id, theme: 'light', profiles: [checkProfile]});
  return updated;
}
