import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {execFileSync} from "node:child_process";
import {sessions} from "../programme.js";
import {freshState, newDraft, setError, estimate, completedSets, workloadWeeks, wrap, validateState, migrateLegacy, parseImport, Store, KEY, BACKUP_KEY, clone} from "../model.js";

const validSet = {kg: "100", reps: "5", rpe: "8", done: true};
function legacyState() {
  return {current: 1, done: [1], bw: 88, drafts: {"1-0": [validSet]}, notes: {1: "Good session"}, conditioning: {1: 1}, history: [{id: 100, date: "2026-08-01T10:00:00.000Z", session: 1, name: "Heavy Upper A", notes: "Old notes", conditioning: "None", sets: [{exercise: "Bench Press", kg: 100, reps: 5, rpe: 8, e1: 116.7, compound: true}]}]};
}
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v)};
  return data;
}
test("all prescriptions are preserved apart from the deliberate Upper A second-pair correction", () => {
  const old = execFileSync("git", ["show", "4916e7d:app.js"], {encoding: "utf8"});
  const start = old.indexOf("const levels=");
  const end = old.indexOf("const fresh=");
  const original = vm.runInNewContext(`${old.slice(start, end)}; JSON.stringify(sessions);`);
  const expected = JSON.parse(original);
  for (const s of expected.filter(s => s.key === "UA")) {
    Object.assign(s.ex[2], {name: "Weighted Pull-up", compound: 1, body: 1});
    Object.assign(s.ex[3], {name: "Barbell Overhead Press", compound: 1, body: false});
  }
  assert.deepEqual(sessions, expected);
});
test("navigation wraps correctly in both directions", () => {
  assert.equal(wrap(0), 12); assert.equal(wrap(13), 1); assert.equal(wrap(1), 1); assert.equal(wrap(12), 12);
});
test("new profiles and drafts are isolated with honest empty defaults", () => {
  const s = freshState(); s.profiles[0].drafts[1] = newDraft(s.profiles[0]);
  s.profiles[0].drafts[1].readiness.energy = 4;
  assert.equal(s.profiles[1].bw, null); assert.equal(s.profiles[1].history.length, 0);
  assert.deepEqual(s.profiles[1].drafts, {});
  assert.equal(newDraft(s.profiles[0]).readiness.energy, null);
  assert.deepEqual(validateState(s), s);
});
test("completion requires explicit load, whole reps and optional valid RPE", () => {
  const e = sessions[0].ex[0];
  assert.match(setError({...validSet, kg: ""}, e), /load/);
  assert.match(setError({...validSet, reps: "2.5"}, e), /whole/);
  assert.match(setError({...validSet, rpe: "11"}, e), /RPE/);
  assert.match(setError({...validSet, rpe: "7.3"}, e), /RPE/);
  assert.match(setError({...validSet, kg: "-5"}, e), /load/);
  assert.equal(setError({...validSet, kg: "0", rpe: ""}, e), "");
});
test("history receives only completed valid sets; mobility is an explicit activity", () => {
  const d = newDraft(freshState().profiles[0]);
  d.exercises[0].sets[0] = validSet;
  d.exercises[0].sets[1] = {...validSet, done: false};
  d.exercises[0].sets[2] = {...validSet, kg: ""};
  assert.equal(completedSets(d).length, 1);
  const lower = newDraft(freshState().profiles[0], 4);
  lower.exercises[1].sets[0].done = true;
  assert.equal(completedSets(lower)[0].mobility, true);
  assert.equal(completedSets(lower)[0].reps, 0);
});
test("e1RM uses actual verified compound sets <=10 reps and BW snapshots", () => {
  const s = {exercise: "Bench Press", kg: 100, reps: 5, rpe: null, done: true};
  assert.equal(estimate(s, null), 100 * (1 + 5 / 30));
  assert.equal(estimate({...s, reps: 1}, null), 100);
  for (const change of [{done: false}, {legacyRecorded: true}, {reps: 11}, {exercise: "Biceps Curl Variation"}, {exercise: "Weighted Dip / Flat DB Press"}]) assert.equal(estimate({...s, ...change}, null), null);
  const pullup = {...s, exercise: "Weighted Pull-up", kg: 20};
  assert.equal(estimate(pullup, null), null);
  assert.equal(estimate(pullup, 80), 100 * (1 + 5 / 30) - 80);
});
test("V2 + pro migration preserves history/drafts but does not invent historical metadata", () => {
  const v2 = legacyState(), started = Date.parse("2026-09-01T10:00:00Z");
  const migrated = migrateLegacy({strengthTrainingTrackerV2: v2, strengthTrainingTrackerProV1: {started, session: 1, readiness: {1: {energy: 4, sleep: 3, joints: 5, date: "2026-09-01T10:01:00Z"}}}});
  const p = migrated.profiles[0];
  assert.equal(p.name, "Ben Hiley");
  assert.equal(p.history[0].sets[0].legacyRecorded, true);
  assert.equal(p.history[0].sets[0].done, false);
  assert.equal(p.history[0].bwSnapshot, null);
  assert.equal(p.history[0].durationSeconds, null);
  assert.equal(p.history[0].readiness.energy, null);
  assert.equal(p.drafts[1].readiness.energy, 4);
  assert.equal(p.drafts[1].startedAt, started);
  assert.equal(p.drafts[1].notes, "Good session");
  assert.equal(p.drafts[1].exercises[0].sets[0].kg, "100");
  assert.deepEqual(p.legacy.sources.strengthTrainingTrackerV2, v2);
  assert.deepEqual(migrated.profiles[1].history, []);
});
test("stale pro readiness is never recycled into an active draft", () => {
  const p = migrateLegacy({strengthTrainingTrackerV2: legacyState(), strengthTrainingTrackerProV1: {started: Date.parse("2026-09-01"), session: 1, readiness: {1: {energy: 5, date: "2026-08-01"}}}}).profiles[0];
  assert.equal(p.drafts[1].readiness.energy, null);
});
test("original cycleLogV1 object ticks survive, different indexed prescriptions stay archived", () => {
  const base = legacyState();
  const old = {cur: 4, done: {"1": true, "3": true, "4": false}, draft: base.drafts, notes: {4: "Original"}, choice: {}, bw: 80, history: base.history};
  const p = migrateLegacy({cycleLogV1: old}).profiles[0];
  assert.deepEqual(p.completed, [1, 3]);
  assert.equal(p.current, 4);
  assert.deepEqual(p.drafts, {});
  assert.deepEqual(p.legacy.sources.cycleLogV1.draft, old.draft);
  assert.match(p.legacy.warnings.join(" "), /different programme/);
});
test("deduplicates copied history, keeps independent records and avoids unsafe copied old drafts", () => {
  const base = legacyState(), old = {cur: 1, done: {}, draft: base.drafts, history: clone(base.history)};
  const p = migrateLegacy({strengthTrainingTrackerV2: base, cycleLogV1: old}).profiles[0];
  assert.equal(p.history.length, 1);
  assert.deepEqual(p.drafts, {});
  old.history[0].sets[0].kg = 90;
  assert.equal(migrateLegacy({strengthTrainingTrackerV2: base, cycleLogV1: old}).profiles[0].history.length, 2);
});
test("malformed legacy data is retained as an archive, not fabricated", () => {
  const x = legacyState(); x.history.push({date: "invalid", sets: []});
  x.history[0].sets.push({exercise: "Invalid", kg: null, reps: 5});
  const p = migrateLegacy({strengthTrainingTrackerV2: x}).profiles[0];
  assert.equal(p.history.length, 1); assert.equal(p.history[0].sets.length, 1);
  assert.equal(p.legacy.sources.strengthTrainingTrackerV2.history.length, 2);
  assert.ok(p.legacy.warnings.length);
});
test("roundtrip exports include all profile draft readiness and timer timestamps", () => {
  const s = freshState(), p = s.profiles[0], d = newDraft(p);
  d.startedAt = Date.now() - 1000; d.restEndAt = Date.now() + 90000; d.readiness.sleep = 5;
  p.drafts[1] = d; s.activeProfileId = "toby";
  assert.deepEqual(parseImport(JSON.parse(JSON.stringify(s))).state, s);
});
test("rejects corrupt and unsupported imports without silent data repair", () => {
  assert.throws(() => parseImport({history: []}));
  assert.throws(() => parseImport({version: 9}));
  const changes = [
    s => s.profiles = [],
    s => s.activeProfileId = "missing",
    s => s.profiles[0].bw = -10,
    s => s.profiles[0].current = 13,
    s => s.profiles[1].id = "ben",
    s => s.profiles[0].history = "oops",
    s => { const p = s.profiles[0]; p.drafts[1] = newDraft(p); p.drafts[1].exercises[0].sets[0] = {...validSet, kg: ""}; },
    s => { const p = s.profiles[0]; p.drafts[1] = newDraft(p); p.drafts[1].readiness.sleep = 8; }
  ];
  changes.forEach(change => { const s = freshState(); change(s); assert.throws(() => validateState(s)); });
});
test("legacy JSON imports are explicitly identified as individual restores", () => {
  assert.equal(parseImport(legacyState()).legacy, true);
  assert.equal(parseImport({cur: 1, history: [], draft: {}, done: {}}).legacy, true);
});
test("storage migration is idempotent and leaves all original keys intact", () => {
  const oldRaw = JSON.stringify(legacyState()), map = fakeStorage({strengthTrainingTrackerV2: oldRaw});
  const store = new Store(() => {}), state = store.load();
  assert.equal(map.get("strengthTrainingTrackerV2"), oldRaw);
  assert.ok(map.has(KEY));
  const again = new Store(() => {}).load();
  assert.deepEqual(again, state);
});
test("blocked storage never crashes the app and reports the failure", () => {
  let error = "";
  Object.defineProperty(globalThis, "localStorage", {configurable: true, get() { throw new Error("blocked"); }});
  const store = new Store(message => error = message), s = store.load();
  assert.equal(s.profiles.length, 3); assert.match(error, /unavailable/);
  assert.equal(store.save(s), false);
  delete globalThis.localStorage;
});
test("corrupt current storage is never overwritten by fresh defaults", () => {
  const map = fakeStorage({[KEY]: "{broken"});
  const store = new Store(() => {}), s = store.load();
  assert.equal(store.locked, true); assert.equal(store.save(s), false);
  assert.equal(map.get(KEY), "{broken");
});
test("imports create durable rollback before replacement, including previous raw", () => {
  const map = fakeStorage(), store = new Store(() => {}), current = store.load(), next = freshState();
  next.profiles[0].name = "Restored";
  store.replace(next, current);
  assert.equal(JSON.parse(map.get(KEY)).profiles[0].name, "Restored");
  const backup = JSON.parse(map.get(BACKUP_KEY));
  assert.equal(backup.state.profiles[0].name, "Ben Hiley");
  assert.ok(backup.previousRaw);
});
test("quota failure creating rollback aborts import without changing saved data", () => {
  const map = fakeStorage(), store = new Store(() => {}), current = store.load(), before = map.get(KEY);
  globalThis.localStorage.setItem = () => { throw new Error("Quota full"); };
  assert.throws(() => store.replace(freshState(), current), /Restore cancelled/);
  assert.equal(map.get(KEY), before);
});
test("cross-tab changes pause writes instead of last-writer-wins data loss", () => {
  const map = fakeStorage(), store = new Store(() => {}), s = store.load();
  map.set(KEY, "another tab");
  assert.equal(store.save(s), false); assert.equal(store.locked, true);
  assert.equal(map.get(KEY), "another tab");
});
test("weekly workload does not double-count across a month boundary", () => {
  const h = [{date: new Date(2026, 8, 15, 10).toISOString(), sets: [{kg: 80, reps: 4}]}];
  const w = workloadWeeks(h, new Date(2026, 8, 15, 12));
  assert.deepEqual(w.map(x => x.start.getDate()), [24, 31, 7, 14]);
  assert.deepEqual(w.map(x => x.total), [0, 0, 0, 320]);
  assert.deepEqual(w.map(x => x.count), [0, 0, 0, 1]);
  assert.equal(w[0].end.getMonth(), 7);
  assert.equal(w[1].end.getMonth(), 8);
});
test("weekly workload uses non-overlapping year boundaries and excludes future records", () => {
  const h = [
    {date: new Date(2025, 11, 31, 10).toISOString(), sets: [{kg: 10, reps: 10}]},
    {date: new Date(2026, 0, 5, 0).toISOString(), sets: [{kg: 20, reps: 10}]},
    {date: new Date(2026, 0, 7, 10).toISOString(), sets: [{kg: 30, reps: 10}]}
  ];
  const w = workloadWeeks(h, new Date(2026, 0, 6, 12));
  assert.deepEqual(w.map(x => x.total), [0, 0, 100, 200]);
  assert.equal(w[2].start.getFullYear(), 2025);
  assert.equal(w[2].end.getFullYear(), 2026);
});
test("weekly boundaries stay at local midnight across daylight saving", () => {
  const oldTimezone = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const w = workloadWeeks([], new Date(2026, 2, 30, 12));
    const transitionWeek = w[2];
    assert.equal(transitionWeek.start.getDate(), 23);
    assert.equal(transitionWeek.end.getDate(), 30);
    assert.equal(transitionWeek.start.getHours(), 0);
    assert.equal(transitionWeek.end.getHours(), 0);
    assert.equal((transitionWeek.end - transitionWeek.start) / 3600000, 167);
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone;
  }
});
