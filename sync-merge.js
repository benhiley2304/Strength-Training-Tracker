import {clone, validateState} from './model.js';
import {sessions} from './programme.js';

// Compare payloads, not object key order, timestamps or transport revisions.
export function equalData(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equalData(a[k], b[k]));
}
const payload = (state, reference) => ({theme: state.theme, profiles: state.profiles.map(p => ({...p,
  // Rendering prepares blank drafts with random IDs. They are not user edits.
  drafts: Object.fromEntries(Object.entries(p.drafts).filter(([key, d]) => { const prior = reference?.profiles.find(x => x.id === p.id)?.drafts[key]; return hasEffort(d, prior); }))
}))});
export const sameState = (a, b) => !!a && !!b && equalData(payload(a, b), payload(b, a));
const copy = x => x === undefined ? undefined : clone(x);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export class ReconcileError extends Error {}
const unsafe = message => { throw new ReconcileError(message); };
export function accountState(state, id) {
  let next;
  try { next = validateState(state); } catch { unsafe('The snapshot is unsupported or corrupt. Export recovery data before replacing it.'); }
  if (next.profiles.length !== 1 || next.activeProfileId !== id || next.profiles[0].id !== id) unsafe('The device snapshot belongs to a different account.');
  return next;
}
// Local *changed fields* win. Unchanged fields always follow the acknowledged remote.
// Workout exercise/set arrays have fixed positional identities in the validated model.
function fields(base, local, remote) {
  if (equalData(local, base)) return copy(remote);
  if (equalData(remote, base) || equalData(local, remote)) return copy(local);
  if (object(local) && object(remote)) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const value = fields(base?.[k], local[k], remote[k]);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote) && local.every(object) && remote.every(object)) {
    if (Array.isArray(base) && (local.length < base.length || remote.length < base.length)) unsafe('Sets were removed while another device edited them. Review both versions.');
    return Array.from({length: Math.max(local.length, remote.length)}, (_, i) => fields(base?.[i], local[i], remote[i]));
  }
  return copy(local);
}
export function hasEffort(d, baselineDraft) {
  // A profile-default change must not turn an inherited blank snapshot into effort.
  // New explicit workout BW edits carry a marker; old same-ID edits use their baseline.
  return !!d && (d.bwSnapshotEdited === true || (baselineDraft?.id === d.id && baselineDraft.bwSnapshot !== d.bwSnapshot) || !!d.startedAt || !!d.restEndAt || !!d.notes || d.conditioning !== 'None' || Object.values(d.readiness).some(x => x !== null) || d.exercises.some((e, i) => e.sets.length !== sessions[d.session - 1].ex[i].sets || e.sets.some(s => s.done || s.kg !== '' || s.reps !== '' || s.rpe !== '')));
}
export function reconcile(base, local, remote, {replacement = false, sameRevision = false, legacyBaseUpdatedAt = null} = {}) {
  const id = remote.activeProfileId;
  remote = accountState(remote, id); local = accountState(local, id);
  if (base) base = accountState(base, id);
  if (sameState(local, remote)) return remote;
  if (replacement) {
    if (!sameRevision && (!base || !sameState(base, remote))) unsafe('An import would replace newer online changes. Review both versions first.');
    return {...local, revision: remote.revision};
  }
  const l = local.profiles[0], r = remote.profiles[0], b = base?.profiles[0];
  const localHistory = new Map(l.history.map(h => [h.id, h])), remoteHistory = new Map(r.history.map(h => [h.id, h])), baseHistory = new Map((b?.history || []).map(h => [h.id, h]));
  const legacyCutoff = Date.parse(legacyBaseUpdatedAt);
  const newerThanLegacyBase = stamp => Number.isFinite(legacyCutoff) && Number.isFinite(stamp) && stamp > legacyCutoff;
  // Without a baseline, an unmatched OLD record may have been intentionally removed
  // online. Only same-revision replay or demonstrably post-ack additions can be unioned.
  if (!b && !sameRevision && l.history.some(h => !remoteHistory.has(h.id) && !newerThanLegacyBase(Date.parse(h.date)))) {
    unsafe('Older device history is missing online and may have been deliberately replaced. Review both archived versions.');
  }
  // History removal means a deliberate replacement, not a routine edit. Never undo it by union.
  if (b && b.history.some(h => !localHistory.has(h.id) || !remoteHistory.has(h.id))) {
    if (!sameState(base, remote) && !sameState(base, local)) unsafe('Workout history was replaced on another device. Review before combining.');
  }
  const omitCollections = state => ({...state, profiles: state.profiles.map(p => ({...p, history: [], drafts: {}, completed: []}))});
  const result = base ? fields(omitCollections(base), omitCollections(local), omitCollections(remote)) : copy(local);
  result.revision = remote.revision;
  const p = result.profiles[0];
  if (!base) {
    // V1 has no baseline: retain explicit local settings, but empty defaults cannot erase remote work.
    if (l.bw === null) p.bw = r.bw;
    if (l.legacy === null) p.legacy = copy(r.legacy);
    if (r.cycle > l.cycle || r.history.some(h => !localHistory.has(h.id))) { p.cycle = r.cycle; p.current = r.current; }
  }
  const histories = new Map(r.history.map(h => [h.id, copy(h)]));
  for (const h of l.history) {
    const old = baseHistory.get(h.id), other = histories.get(h.id);
    if (old && !other) continue; // Explicit remote deletion, when local is otherwise unchanged.
    histories.set(h.id, other ? fields(old, h, other) : copy(h));
  }
  if (b) for (const old of b.history) if (!localHistory.has(old.id)) histories.delete(old.id);
  p.history = [...histories.values()];
  p.completed = copy(p.cycle === l.cycle ? l.completed : r.completed);
  if (l.cycle === r.cycle) {
    p.completed = [...new Set([...l.completed, ...r.completed])].sort((a, b) => a - b);
  }
  if (l.cycle < r.cycle) { p.cycle = r.cycle; p.current = r.current; p.completed = copy(r.completed); }
  p.drafts = {};
  const eligible = (d, bd) => {
    if (!d || d.cycle < p.cycle || histories.has(d.id)) return undefined;
    const finishes = p.history.filter(h => h.session === d.session && h.cycle === d.cycle);
    if (finishes.length && !(hasEffort(d, bd) && d.startedAt && finishes.every(h => d.startedAt > Date.parse(h.date)) && bd?.id !== d.id)) return undefined;
    return d;
  };
  for (const key of new Set([...Object.keys(l.drafts), ...Object.keys(r.drafts)])) {
    const bd = b?.drafts[key], ld = eligible(l.drafts[key], bd), rd = eligible(r.drafts[key], bd);
    if (!b && !sameRevision && ld && ld.id !== rd?.id && hasEffort(ld) && !newerThanLegacyBase(ld.startedAt)) {
      unsafe('An older unfinished device workout is missing online and may have been deliberately removed. Review both archived versions.');
    }
    let d;
    if (ld && rd && ld.id !== rd.id) {
      if (!hasEffort(ld, bd)) d = copy(rd);
      else if (!hasEffort(rd, bd)) d = copy(ld);
      else if (bd?.id === ld.id && equalData(ld, bd)) d = copy(rd);
      else if (bd?.id === rd.id && equalData(rd, bd)) d = copy(ld);
      else unsafe('Two different unfinished workouts occupy the same session. Both are in device recovery.');
    } else if (ld && rd) d = fields(bd, ld, rd);
    else if (ld) {
      if (!hasEffort(ld, bd)) continue; // Do not upload an untouched render-created draft.
      if (bd?.id === ld.id) continue; // Remote finish/reset removed this exact draft: never resurrect it.
      d = copy(ld);
    } else if (rd) {
      if (bd?.id === rd.id) continue; // Local finish/reset removed this exact draft.
      d = copy(rd);
    }
    if (!d) continue;
    p.drafts[key] = d;
  }
  return accountState(result, id);
}
