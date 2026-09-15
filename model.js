import {sessions, exerciseFor} from "./programme.js";

export const APP = "Strength Training Tracker";
export const KEY = "strengthTrainingTrackerProfilesV3";
export const BACKUP_KEY = `${KEY}:rollback`;
export const LEGACY_KEYS = ["strengthTrainingTrackerV2", "strengthTrainingTrackerProV1", "cycleLogV1"];
export const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const clone = value => JSON.parse(JSON.stringify(value));
export const blankSet = () => ({kg: "", reps: "", rpe: "", done: false});
export const readiness = () => ({energy: null, sleep: null, joints: null});
export function newProfile(name, id = uid()) {
  return {id, name, bw: null, current: 1, cycle: 1, completed: [], drafts: {}, history: [], restSeconds: 90, legacy: null};
}
export function freshState() {
  return {app: APP, version: 3, revision: 0, activeProfileId: "ben", theme: "light", profiles: [newProfile("Ben Hiley", "ben"), newProfile("Toby", "toby"), newProfile("Will", "will")]};
}
export function newDraft(profile, sessionId = profile.current) {
  return {id: uid(), session: sessionId, cycle: profile.cycle, startedAt: null, bwSnapshot: profile.bw,
    readiness: readiness(), notes: "", conditioning: "None", restEndAt: null,
    exercises: sessions[sessionId - 1].ex.map(e => ({name: e.name, sets: Array.from({length: e.sets}, blankSet)}))};
}
export const wrap = n => ((n - 1) % 12 + 12) % 12 + 1;
export function setError(set, exercise) {
  if (exercise.name === "Spinal Decompression") return "";
  if (set.kg === null || String(set.kg ?? "").trim() === "" || !Number.isFinite(Number(set.kg)) || +set.kg < 0 || +set.kg > 1500) return "Enter a load from 0 to 1,500 kg. Use 0 for no added load.";
  if (String(set.reps ?? "").trim() === "" || !Number.isInteger(+set.reps) || +set.reps < 1 || +set.reps > 200) return "Enter 1–200 whole reps.";
  if (set.rpe !== "" && (!Number.isFinite(+set.rpe) || +set.rpe < 1 || +set.rpe > 10 || (+set.rpe * 2) % 1)) return "RPE is optional; use 1–10 in half-point steps.";
  return "";
}
/** Only verified, completed compound sets qualify. BW is the workout snapshot, never today's BW. */
export function estimate(set, bw) {
  const e = exerciseFor(set.exercise);
  if (!e?.compound || !set.done || set.legacyRecorded || set.reps > 10 || set.reps < 1 || setError({...set, rpe: set.rpe ?? ""}, e)) return null;
  // The combined dip / DB prescription does not identify which movement was performed.
  if (e.name === "Weighted Dip / Flat DB Press") return null;
  if (e.body && !(bw > 0)) return null;
  const load = set.kg + (e.body ? bw : 0);
  if (load <= 0) return null;
  return (set.reps === 1 ? load : load * (1 + set.reps / 30)) - (e.body ? bw : 0);
}
export const volume = h => h.sets.reduce((total, s) => total + (Number.isFinite(s.kg) && Number.isFinite(s.reps) ? s.kg * s.reps : 0), 0);
/** Local-calendar weeks, not fixed milliseconds: handles month/year boundaries and DST. */
export function workloadWeeks(history, now = Date.now()) {
  const today = new Date(now);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return Array.from({length: 4}, (_, i) => {
    const start = new Date(monday);
    start.setDate(start.getDate() - (3 - i) * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const entries = history.filter(h => Date.parse(h.date) >= +start && Date.parse(h.date) < +end && Date.parse(h.date) <= +today);
    return {start, end, total: entries.reduce((n, h) => n + volume(h), 0), count: entries.length};
  });
}
export function completedSets(draft) {
  return draft.exercises.flatMap((ex, i) => ex.sets.flatMap((s, j) => {
    const e = sessions[draft.session - 1].ex[i];
    if (!s.done || setError(s, e)) return [];
    return [{exercise: ex.name, set: j + 1, kg: e.cat === "Mobility" ? 0 : +s.kg,
      reps: e.cat === "Mobility" ? 0 : +s.reps, rpe: e.cat === "Mobility" || s.rpe === "" ? null : +s.rpe,
      done: true, compound: !!e.compound, body: !!e.body, mobility: e.cat === "Mobility"}];
  }));
}

// Strict import validation: reject malformed values rather than silently repairing a restore.
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x, max = 10000) => typeof x === "string" && x.length <= max;
const num = (x, lo, hi) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const integer = (x, lo, hi) => num(x, lo, hi) && Number.isInteger(x);
const stamp = x => x === null || num(x, 0, 8640000000000000);
const bwValid = x => x === null || num(x, 20, 500);
function check(ok, message) { if (!ok) throw new Error(message); }
function validReady(r) {
  return obj(r) && ["energy", "sleep", "joints"].every(k => r[k] === null || integer(r[k], 1, 5));
}
function validateSet(s, draft, e) {
  check(obj(s) && typeof s.done === "boolean", "Invalid set completion flag.");
  if (draft) {
    check(["kg", "reps", "rpe"].every(k => text(s[k], 32)), "Draft set values must be text.");
    check(!s.done || !setError(s, e), "A completed draft set is invalid.");
  } else {
    check(text(s.exercise, 160) && s.exercise.length > 0 && integer(s.set, 1, 100), "Invalid history exercise.");
    check(num(s.kg, 0, 1500) && integer(s.reps, s.mobility ? 0 : 1, 200), "Invalid historical load or reps.");
    check(s.rpe === null || (num(s.rpe, 1, 10) && (s.rpe * 2) % 1 === 0), "Invalid historical RPE.");
    check(s.done || s.legacyRecorded === true, "History contains an uncompleted set.");
  }
}
export function validateState(data) {
  check(obj(data) && data.app === APP && data.version === 3, "This is not a supported profiles backup (version 3).");
  check(integer(data.revision, 0, Number.MAX_SAFE_INTEGER) && ["light", "dark", "system"].includes(data.theme), "Invalid app settings.");
  check(Array.isArray(data.profiles) && data.profiles.length >= 1 && data.profiles.length <= 50, "A backup must contain 1–50 profiles.");
  const ids = new Set();
  for (const p of data.profiles) {
    check(obj(p) && text(p.id, 100) && p.id.length && !ids.has(p.id) && text(p.name, 40) && p.name.trim(), "Profile names or IDs are invalid or duplicated.");
    ids.add(p.id);
    check(bwValid(p.bw) && integer(p.current, 1, 12) && integer(p.cycle, 1, 100000) && integer(p.restSeconds, 0, 600), "Invalid profile settings.");
    check(Array.isArray(p.completed) && p.completed.length <= 12 && p.completed.every(n => integer(n, 1, 12)) && new Set(p.completed).size === p.completed.length, "Invalid cycle completion list.");
    check(obj(p.drafts) && Object.keys(p.drafts).length <= 12, "Invalid workout drafts.");
    const draftIds = new Set();
    for (const [key, d] of Object.entries(p.drafts)) {
      check(obj(d) && integer(d.session, 1, 12) && key === String(d.session) && text(d.id, 100) && d.id.length && integer(d.cycle, 1, 100000), "Invalid draft identity.");
      check(!draftIds.has(d.id), "Duplicate draft workout ID.");
      draftIds.add(d.id);
      check(stamp(d.startedAt) && stamp(d.restEndAt) && bwValid(d.bwSnapshot) && validReady(d.readiness) && text(d.notes) && text(d.conditioning, 200), "Invalid draft details.");
      const ex = sessions[d.session - 1].ex;
      check(Array.isArray(d.exercises) && d.exercises.length === ex.length, "The draft does not match the programme.");
      d.exercises.forEach((x, i) => {
        check(obj(x) && x.name === ex[i].name && Array.isArray(x.sets) && x.sets.length >= ex[i].sets && x.sets.length <= 100, "Invalid exercise draft.");
        x.sets.forEach(s => validateSet(s, true, ex[i]));
      });
    }
    check(Array.isArray(p.history) && p.history.length <= 20000, "Invalid history.");
    const workoutIds = new Set();
    for (const h of p.history) {
      check(obj(h) && text(h.id, 160) && h.id.length && !workoutIds.has(h.id) && !draftIds.has(h.id), "Duplicate or invalid workout ID.");
      workoutIds.add(h.id);
      check(text(h.date, 40) && Number.isFinite(Date.parse(h.date)) && integer(h.session, 1, 12) && text(h.name, 160) && text(h.notes) && text(h.conditioning, 200), "Invalid workout details.");
      check(integer(h.cycle, 1, 100000) && stamp(h.startedAt) && (h.durationSeconds === null || num(h.durationSeconds, 0, 8640000000)) && bwValid(h.bwSnapshot) && validReady(h.readiness), "Invalid workout time, bodyweight or readiness.");
      check(typeof h.partial === "boolean" && Array.isArray(h.sets) && h.sets.length <= 1200, "Invalid workout sets.");
      h.sets.forEach(s => validateSet(s, false));
    }
    check(p.legacy === null || (obj(p.legacy) && obj(p.legacy.sources) && Array.isArray(p.legacy.warnings) && p.legacy.warnings.every(s => text(s))), "Invalid legacy archive.");
  }
  check(ids.has(data.activeProfileId), "The active profile is missing.");
  return clone(data);
}

function legacyCore(x) {
  return obj(x) && Array.isArray(x.history) && ("current" in x || "cur" in x) && x.history.length <= 20000;
}
/** Both historical apps saved filled sets regardless of ticks. Preserve, but never claim verified completion. */
export function migrateLegacy(sources) {
  const state = freshState(), p = state.profiles[0];
  const v2 = sources.strengthTrainingTrackerV2, old = sources.cycleLogV1, pro = sources.strengthTrainingTrackerProV1;
  const base = legacyCore(v2) ? v2 : legacyCore(old) ? old : null;
  p.legacy = {sources: clone(sources), warnings: []};
  const warnings = p.legacy.warnings;
  if (!base) {
    warnings.push("Legacy data was archived but could not be safely interpreted.");
    return state;
  }
  const isV2 = base === v2;
  p.current = integer(+(base.current ?? base.cur), 1, 12) ? +(base.current ?? base.cur) : 1;
  p.bw = bwValid(+base.bw) ? +base.bw : null;
  if (["light", "dark", "system"].includes(base.theme)) state.theme = base.theme;
  const done = Array.isArray(base.done) ? base.done : obj(base.done) ? Object.keys(base.done).filter(k => base.done[k]).map(Number) : [];
  p.completed = [...new Set(done.filter(n => integer(n, 1, 12)))];
  const seen = new Set();
  for (const source of [v2, old].filter(legacyCore)) {
    for (const h of source.history) {
      const fingerprint = JSON.stringify([h?.id, h?.date, h?.session, h?.sets]);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      if (!obj(h) || !integer(+h.session, 1, 12) || !Number.isFinite(Date.parse(h.date)) || !Array.isArray(h.sets)) {
        warnings.push("An unreadable history entry is retained in the legacy archive."); continue;
      }
      const sets = [];
      h.sets.forEach((s, i) => {
        if (!obj(s) || !text(s.exercise, 160) || !s.exercise || !num(s.kg, 0, 1500) || !integer(s.reps, 1, 200)) {
          warnings.push("An invalid historical set is retained in the legacy archive."); return;
        }
        sets.push({exercise: s.exercise, set: Math.min(i + 1, 100), kg: s.kg, reps: s.reps,
          rpe: num(s.rpe, 1, 10) && (s.rpe * 2) % 1 === 0 ? s.rpe : null,
          done: false, legacyRecorded: true, compound: !!s.compound, body: s.mode === 2 || s.exercise.toLowerCase() === "weighted pull-up"});
      });
      p.history.push({id: `legacy-${uid()}`, date: new Date(h.date).toISOString(), session: +h.session,
        name: String(h.name || sessions[+h.session - 1].name).slice(0, 160), cycle: 1,
        startedAt: null, durationSeconds: null, bwSnapshot: null, readiness: readiness(), partial: true,
        notes: String(h.notes || "").slice(0, 10000), conditioning: String(h.conditioning || "").slice(0, 200),
        sets, legacy: true});
    }
  }
  // cycleLogV1 used a DIFFERENT exercise list. Never assign those index-based drafts to today's lifts.
  const copiedOldDraft = legacyCore(old) && JSON.stringify(v2?.drafts) === JSON.stringify(old.draft) && Object.keys(old.draft || {}).length > 0;
  if (isV2 && !copiedOldDraft) {
    for (const s of sessions) {
      const hasDraft = s.ex.some((_, i) => Array.isArray(base.drafts?.[`${s.id}-${i}`]));
      const hasNotes = typeof base.notes?.[s.id] === "string" && base.notes[s.id].length > 0;
      if (!hasDraft && !hasNotes && !(pro?.started && +pro.session === s.id)) continue;
      const d = newDraft(p, s.id);
      s.ex.forEach((e, i) => {
        const rows = base.drafts?.[`${s.id}-${i}`];
        if (!Array.isArray(rows)) return;
        d.exercises[i].sets = rows.slice(0, 100).map(x => {
          const r = {kg: String(x?.kg ?? "").slice(0, 32), reps: String(x?.reps ?? "").slice(0, 32), rpe: String(x?.rpe ?? "").slice(0, 32), done: x?.done === true};
          if (setError(r, e)) r.done = false;
          return r;
        });
        while (d.exercises[i].sets.length < e.sets) d.exercises[i].sets.push(blankSet());
      });
      d.notes = String(base.notes?.[s.id] || "").slice(0, 10000);
      const cond = ["None", "Assault bike · 3 × 1 min", "Rower · 3 × 1 min", "Zone 2 · 20–30 min"];
      d.conditioning = cond[base.conditioning?.[s.id]] || "None";
      const hasActivity = d.exercises.some(e => e.sets.some(x => x.kg !== "" || x.reps !== "" || x.done));
      if (pro?.started && +pro.session === s.id && num(pro.started, 1, Date.now()) && hasActivity) {
        d.startedAt = pro.started;
        const r = pro.readiness?.[s.id];
        // Readiness had been recycled by the old app; only attach a check-in timestamped after this start.
        if (r && Date.parse(r.date) >= d.startedAt) {
          for (const k of ["energy", "sleep", "joints"]) d.readiness[k] = integer(r[k], 1, 5) ? r[k] : null;
        }
      }
      p.drafts[s.id] = d;
    }
  }
  if (legacyCore(old) && Object.keys(old.draft || {}).length) warnings.push("Original cycleLogV1 drafts use a different programme. They are preserved in the downloadable legacy archive, not assigned to different exercises.");
  if (pro) warnings.push("Old readiness is archived; only timestamp-matched active check-ins were attached. Historical readiness, duration and bodyweight were not recorded. Old rest countdowns were not persisted.");
  if (p.history.length) warnings.push("Legacy workouts are preserved as recorded. Their apps did not record set completion or bodyweight snapshots; they are excluded from verified strength estimates.");
  p.history.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  p.legacy.warnings = [...new Set(warnings)];
  return validateState(state);
}

export function parseImport(value) {
  if (value?.version === 3) return {state: validateState(value), legacy: false};
  if (legacyCore(value)) return {state: migrateLegacy({[("cur" in value) ? "cycleLogV1" : "strengthTrainingTrackerV2"]: value}), legacy: true};
  if (obj(value) && (legacyCore(value.strengthTrainingTrackerV2) || legacyCore(value.cycleLogV1))) return {state: migrateLegacy(value), legacy: true};
  throw new Error("Unsupported backup. Choose a version 3 profiles export, or an original tracker JSON export.");
}

/** localStorage is deliberately used: this is an offline, device-only app. Every access is guarded. */
export class Store {
  constructor(onError) { this.onError = onError; this.raw = null; this.locked = false; this.failed = false; }
  problem(message) { this.failed = true; this.onError(message); }
  load() {
    try {
      this.raw = localStorage.getItem(KEY);
      if (this.raw) {
        try { return validateState(JSON.parse(this.raw)); }
        catch { this.locked = true; this.problem("Saved profiles could not be read. Nothing has been overwritten. Export recovery data in Settings, then restore a valid backup."); return freshState(); }
      }
      const sources = {};
      for (const key of LEGACY_KEYS) {
        const raw = localStorage.getItem(key);
        if (raw) { try { sources[key] = JSON.parse(raw); } catch { sources[key] = {unreadableRaw: raw}; } }
      }
      const state = Object.keys(sources).length ? migrateLegacy(sources) : freshState();
      this.save(state); return state;
    } catch {
      this.problem("Local storage is unavailable. Changes exist only in this tab and will be lost on reload. Export a backup before leaving. Open the app directly if this is a blocked preview.");
      return freshState();
    }
  }
  save(state) {
    if (this.locked) return false;
    try {
      const current = localStorage.getItem(KEY);
      if (current !== this.raw) {
        this.locked = true;
        this.problem("Another tab changed this tracker. Saving is paused to prevent overwriting it. Export this tab's work, then reload.");
        return false;
      }
      state.revision++;
      const raw = JSON.stringify(state);
      localStorage.setItem(KEY, raw);
      this.raw = raw; this.failed = false; return true;
    } catch {
      this.problem("Changes could not be saved: storage is blocked or full. Keep this tab open and export a backup before leaving.");
      return false;
    }
  }
  replace(next, current) {
    // Refuse destructive restore unless a durable rollback can be written FIRST.
    const backup = {app: APP, rollbackAt: new Date().toISOString(), state: clone(current), previousRaw: this.raw};
    try {
      if (localStorage.getItem(KEY) !== this.raw) throw new Error("Another tab has changed the data. Reload before restoring.");
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
      const raw = JSON.stringify(validateState(next));
      localStorage.setItem(KEY, raw);
      this.raw = raw; this.locked = false; this.failed = false;
      return backup;
    } catch (error) { throw new Error(`Restore cancelled. ${error.message} Your current profiles have not been replaced.`); }
  }
  rollback() {
    try { const raw = localStorage.getItem(BACKUP_KEY); return raw ? JSON.parse(raw) : null; }
    catch { throw new Error("The local rollback backup could not be read."); }
  }
}
