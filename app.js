import {sessions, conditioning, targetReps, exerciseFor} from "./programme.js";
import {APP, KEY, Store, newProfile, newDraft, blankSet, clone, wrap, setError, completedSets, estimate, volume, workloadWeeks, parseImport, validateState} from "./model.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const number = value => new Intl.NumberFormat("en-GB", {maximumFractionDigits: 1}).format(value);
const date = (value, year = false) => new Date(value).toLocaleDateString("en-GB", {day: "numeric", month: "short", ...(year ? {year: "numeric"} : {})});
const duration = seconds => {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
};
const titles = {train: "Train", programme: "Programme", progress: "Progress", settings: "Settings"};
const store = new Store(message => {
  $("#storage-error").textContent = message;
  $("#storage-error").hidden = false;
  $("#save-status").textContent = "Not saved · export a backup";
});
let state = store.load();
let view = titles[location.hash.slice(1)] ? location.hash.slice(1) : "train";
let openExercises = new Set([0]);
let toastTimeout;
let waitingWorker = null;
let importBusy = false;
let finishBusy = false;
let confirmAction = null;
let editProfileId = null;
const profile = () => state.profiles.find(p => p.id === state.activeProfileId);
const session = () => sessions[profile().current - 1];
function draft() {
  const p = profile();
  if (!p.drafts[p.current]) p.drafts[p.current] = newDraft(p);
  return p.drafts[p.current];
}
function persist() {
  const saved = store.save(state);
  $("#save-status").textContent = saved ? "Saved on this device" : "Not saved · export a backup";
  if (saved) $("#storage-error").hidden = true;
  return saved;
}
function toast(message) {
  clearTimeout(toastTimeout);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimeout = setTimeout(() => $("#toast").classList.remove("visible"), 4200);
}
function showDialog(selector, html) {
  const el = $(selector);
  el.innerHTML = html;
  if (!el.open) el.showModal();
}
const closeButton = `<button class="icon-button close-dialog" data-action="close-dialog" aria-label="Close dialog">×</button>`;
function confirmDialog(title, message, label, action, danger = false) {
  confirmAction = action;
  showDialog("#confirm-dialog", `<div class="dialog-heading"><h2 id="confirm-title">${escape(title)}</h2>${closeButton}</div><p class="dialog-copy">${escape(message)}</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog" autofocus>Cancel</button><button class="button ${danger ? "danger" : "primary"}" id="confirm-accept" data-action="confirm">${escape(label)}</button></div>`);
}
function theme() {
  const dark = state.theme === "dark" || (state.theme === "system" && matchMedia("(prefers-color-scheme:dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} appearance`);
}
function render() {
  const p = profile();
  $("#profile-name").textContent = p.name;
  $("#profile-avatar").textContent = p.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase();
  $("#view-label").textContent = titles[view];
  $$("[data-view]").forEach(a => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.title = `${titles[view]} · ${p.name} · ${APP}`;
  theme();
  ({train: renderTrain, programme: renderProgramme, progress: renderProgress, settings: renderSettings})[view]();
  renderRest();
}
function navigate(next) {
  view = titles[next] ? next : "train";
  render();
  window.scrollTo({top: 0, behavior: "instant"});
}
function goSession(n) {
  profile().current = wrap(n);
  openExercises = new Set([0]);
  persist();
  if (location.hash !== "#train") location.hash = "train";
  else navigate("train");
}
function startSession() {
  const d = draft();
  if (d.startedAt === null) d.startedAt = Date.now();
}
function previous(name) {
  return [...profile().history].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .find(h => h.sets.some(s => s.exercise.toLowerCase() === name.toLowerCase()));
}
function previousHTML(name) {
  const h = previous(name);
  if (!h) return `<span class="previous">Previous: <span>No logged sets yet</span></span>`;
  const sets = h.sets.filter(s => s.exercise.toLowerCase() === name.toLowerCase());
  return `<span class="previous">Previous · ${date(h.date)}${h.legacy ? " · legacy" : ""}<span>${sets.slice(0, 4).map(s => `${number(s.kg)} kg × ${s.reps}`).join(" / ")}${sets.length > 4 ? ` +${sets.length - 4} more` : ""}</span></span>`;
}
function setHTML(s, i, j, e) {
  const mobility = e.cat === "Mobility";
  return `<div class="set-row ${s.done ? "is-done" : ""}" data-ex="${i}" data-set="${j}">
    <span class="set-number">${j + 1}</span>
    ${mobility ? `<span class="mobility-note">Decompress · no load or reps prescribed</span>` : ["kg", "reps", "rpe"].map(key => {
      const title = key === "kg" ? (e.body ? "Added load kg" : "Load kg") : key === "reps" ? "Reps" : "RPE (optional)";
      return `<label class="set-field"><span class="sr-only">${escape(e.name)} set ${j + 1} ${title}</span><input data-field="${key}" data-testid="set-${i}-${j}-${key}" type="number" inputmode="${key === "reps" ? "numeric" : "decimal"}" min="${key === "reps" || key === "rpe" ? 1 : 0}" max="${key === "reps" ? 200 : key === "rpe" ? 10 : 1500}" step="${key === "reps" ? 1 : key === "rpe" ? 0.5 : "any"}" value="${escape(s[key])}" placeholder="${key === "reps" ? targetReps(e, j) : key === "kg" ? "—" : "—"}" ${s.done ? "readonly" : ""}></label>`;
    }).join("")}
    <button class="complete-set ${s.done ? "checked" : ""}" data-action="complete-set" data-testid="complete-${i}-${j}" aria-pressed="${s.done}" aria-label="${s.done ? "Unmark" : "Complete"} ${escape(e.name)} set ${j + 1}">${s.done ? "✓" : "<span aria-hidden='true'>✓</span>"}</button>
    <button class="set-more" data-action="clear-set" title="${j >= e.sets ? "Remove added set" : "Clear set"}" aria-label="${j >= e.sets ? "Remove added" : "Clear"} ${escape(e.name)} set ${j + 1}">×</button>
    <p class="set-error" aria-live="polite" hidden></p>
  </div>`;
}
function exerciseHTML(e, i) {
  const d = draft().exercises[i], done = d.sets.filter(s => s.done && !setError(s, e)).length;
  return `<article class="exercise ${done === d.sets.length ? "exercise-complete" : ""}" data-exercise="${i}">
    <h2><button class="exercise-toggle" data-action="accordion" data-index="${i}" aria-expanded="${openExercises.has(i)}" aria-controls="exercise-panel-${i}" id="exercise-heading-${i}">
      <span class="exercise-index">${String(i + 1).padStart(2, "0")}</span><span class="exercise-title"><span>${escape(e.name)}</span><small>${escape(e.cat)} <span aria-hidden="true">·</span> ${e.sets} × ${e.reps}</small></span>
      <span class="exercise-counter">${done}/${d.sets.length}</span><span class="chevron" aria-hidden="true">⌄</span>
    </button></h2>
    <div class="exercise-panel" id="exercise-panel-${i}" role="region" aria-labelledby="exercise-heading-${i}" ${openExercises.has(i) ? "" : "hidden"}>
      ${previousHTML(e.name)}
      ${e.body ? '<p class="load-hint">Log added weight only; 0 = bodyweight. Workout bodyweight is snapshotted for estimates.</p>' : e.name === "Weighted Dip / Flat DB Press" ? '<p class="load-hint">Dip: added load. DB press: combined dumbbell load. Note which you did; this mixed movement has no e1RM estimate.</p>' : ""}
      <div class="set-labels" aria-hidden="true"><span>SET</span>${e.cat === "Mobility" ? '<span class="mobility-note">ACTIVITY</span>' : `<span>${e.body ? "ADDED KG" : "KG"}</span><span>REPS</span><span>RPE <small>opt.</small></span>`}<span>DONE</span><span></span></div>
      <div class="set-list">${d.sets.map((s, j) => setHTML(s, i, j, e)).join("")}</div>
      <div class="exercise-foot"><button class="text-button" data-action="add-set" data-index="${i}">+ Add set</button><span>${e.compound ? "Controlled reps. Full rest." : "Quality over load."}</span></div>
    </div>
  </article>`;
}
function readinessHTML(d) {
  return `<details class="panel check-in"><summary><span>Session check-in</span><span class="muted">${Object.values(d.readiness).some(v => v !== null) ? "Added" : "Optional"} ⌄</span></summary><div class="panel-body">
    <p class="small muted">How are you arriving? 1 = low / poor, 5 = high / good. Joints: 5 = comfortable.</p>
    <div class="readiness-fields">${["energy", "sleep", "joints"].map(key => `<label>${key[0].toUpperCase() + key.slice(1)}<select data-readiness="${key}" aria-label="${key} readiness"><option value="">Not recorded</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${d.readiness[key] === n ? "selected" : ""}>${n} / 5</option>`).join("")}</select></label>`).join("")}</div>
    <label class="form-label">Bodyweight for this workout (kg)<input id="workout-bw" type="number" min="20" max="500" step="any" inputmode="decimal" value="${d.bwSnapshot ?? ""}" placeholder="Not recorded"></label><p class="small muted">This snapshot stays with this workout. Change your default in Settings.</p>
  </div></details>`;
}
function renderTrain() {
  const p = profile(), s = session(), d = draft();
  const done = completedSets(d).length, total = d.exercises.reduce((n, e) => n + e.sets.length, 0);
  $("#main").innerHTML = `<div class="page-heading"><div><p class="eyebrow">YOUR NEXT SESSION</p><h1>Let's put the work in.</h1></div><span class="cycle-label">CYCLE ${String(p.cycle).padStart(2, "0")}</span></div>
    <section class="session-banner" aria-label="Current session"><div class="session-banner-top"><span class="eyebrow">SESSION ${String(s.id).padStart(2, "0")} <span class="quiet">/ 12</span></span><div class="session-arrows"><button data-action="previous" aria-label="Previous session">←</button><button data-action="next" aria-label="Next session">→</button></div></div><div class="session-banner-title"><div><h2>${s.name}</h2><p>${s.focus}</p></div><span class="intensity ${s.intensity}">${s.intensity}</span></div><div class="session-banner-bottom"><span>${s.ex.length} exercises <span class="quiet">/</span> ${total} planned sets</span><a href="#programme">View programme ↗</a></div></section>
    <div class="workout-layout"><section class="exercise-column" aria-label="Workout exercises"><div class="section-heading"><h2>Workout</h2><button class="text-button" data-action="expand-all">${openExercises.size === s.ex.length ? "Collapse all" : "Expand all"}</button></div><p class="workout-help">Enter your load and reps, then tick each finished set. RPE is optional.</p><div id="exercises">${s.ex.map(exerciseHTML).join("")}</div></section>
    <aside class="workout-aside" aria-label="Session tools">
      <section class="panel session-status"><div class="section-heading"><h2>Session progress</h2><span id="session-percent">${Math.round(done / total * 100)}%</span></div><progress id="session-progress" value="${done}" max="${total}" aria-label="Completed sets"></progress><p id="set-summary">${done} of ${total} sets complete</p><div class="clock-row"><span>Elapsed time</span><strong id="session-clock">${duration(d.startedAt ? (Date.now() - d.startedAt) / 1000 : 0)}</strong></div><button class="button secondary full" data-action="start" ${d.startedAt ? "disabled" : ""}>${d.startedAt ? "Session in progress" : "Start session timer"}</button><button id="finish-workout" class="button primary full" data-action="finish">Finish workout <span aria-hidden="true">↗</span></button><p class="small muted">Only completed, valid sets are saved.</p></section>
      ${readinessHTML(d)}
      <details class="panel"><summary><span>Notes & conditioning</span><span class="muted">⌄</span></summary><div class="panel-body"><label class="form-label">Session notes<textarea id="workout-notes" rows="3" maxlength="10000" placeholder="How did it feel? Any substitutions?">${escape(d.notes)}</textarea></label><label class="form-label">Conditioning<select id="conditioning">${[...new Set([...conditioning, d.conditioning])].map(c => `<option ${c === d.conditioning ? "selected" : ""}>${escape(c)}</option>`).join("")}</select></label></div></details>
      <section class="coach-note"><span class="eyebrow">THE INTENT</span><p>${s.intensity === "heavy" ? "Take full rests. Leave a clean rep in reserve." : s.intensity === "medium" ? "Build crisp volume without grinding." : "Move well, own every rep, and recover for the next exposure."}</p></section>
    </aside></div>`;
}
function updateExercise(i, focusSet = null) {
  const node = $(`[data-exercise="${i}"]`);
  if (node) node.outerHTML = exerciseHTML(session().ex[i], i);
  const count = completedSets(draft()).length, total = draft().exercises.reduce((n, e) => n + e.sets.length, 0);
  if ($("#set-summary")) {
    $("#set-summary").textContent = `${count} of ${total} sets complete`;
    $("#session-percent").textContent = `${Math.round(count / total * 100)}%`;
    $("#session-progress").value = count;
    $("#session-progress").max = total;
  }
  if (focusSet !== null) $(`[data-testid="complete-${i}-${focusSet}"]`)?.focus({preventScroll: true});
}
function renderProgramme() {
  const p = profile();
  $("#main").innerHTML = `<div class="page-heading"><div><p class="eyebrow">THE LONG GAME</p><h1>Your 12-session programme</h1><p class="muted">Upper / lower. Heavy / medium / light. Follow the sequence at your own pace.</p></div></div>
    <div class="programme-overview"><div><span class="eyebrow">CYCLE ${String(p.cycle).padStart(2, "0")}</span><p><strong>${p.completed.length}</strong> / 12 sessions logged this cycle</p></div><span class="small muted">Partial workouts count as logged, not fully completed.</span></div>
    <div class="programme-grid">${sessions.map(s => `<article class="plan-session ${s.id === p.current ? "current" : ""}"><div class="plan-top"><span class="plan-number">${String(s.id).padStart(2, "0")}</span><span class="intensity ${s.intensity}">${s.intensity}</span><span class="plan-state">${s.id === p.current ? "CURRENT" : p.completed.includes(s.id) ? "LOGGED" : ""}</span></div><h2>${s.name}</h2><p>${s.focus}</p><details class="prescriptions"><summary>${s.ex.length} exercises · See prescriptions</summary><ul>${s.ex.map(e => `<li><span>${escape(e.name)}</span><strong>${e.sets} × ${e.reps}</strong></li>`).join("")}</ul></details><button class="button ${s.id === p.current ? "primary" : "secondary"} full" data-action="choose-session" data-session="${s.id}">${s.id === p.current ? "Continue session" : "Open session"} <span aria-hidden="true">↗</span></button></article>`).join("")}</div>
    <p class="small muted section-note">Browsing wraps 12 → 1 without changing your cycle. Finishing session 12 begins the next cycle. Training drafts stay attached to their session until saved or explicitly cleared.</p>`;
}
const weeks = () => workloadWeeks(profile().history).map(w => ({...w, label: date(w.start)}));
function renderProgress() {
  const p = profile(), hist = [...p.history].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const verified = hist.filter(h => !h.legacy), count = verified.reduce((n, h) => n + h.sets.length, 0), w = weeks(), max = Math.max(1, ...w.map(x => x.total));
  const records = {};
  for (const h of hist) for (const s of h.sets) {
    const e1 = estimate(s, h.bwSnapshot);
    if (e1 !== null && (!records[s.exercise] || e1 > records[s.exercise].e1)) records[s.exercise] = {e1, set: s, date: h.date, bw: h.bwSnapshot};
  }
  $("#main").innerHTML = `<div class="page-heading"><div><p class="eyebrow">PROGRESS, NOT GUESSWORK</p><h1>Your work adds up.</h1><p class="muted">A training record for ${escape(p.name)}. Nothing here is sample data.</p></div></div>
    <div class="metrics"><div><span>Workouts logged</span><strong>${hist.length}</strong></div><div><span>Verified completed sets</span><strong>${count}</strong></div><div><span>Current cycle logged</span><strong>${p.completed.length}<small> / 12</small></strong></div></div>
    <div class="progress-layout"><section class="panel analytics-panel"><div class="section-heading"><h2>Four-week workload</h2><span class="small muted">kg · external load</span></div><p class="small muted">Load × reps as entered. Bodyweight is excluded. Legacy recorded sets included; not a measure of effort.</p><div class="bar-chart" role="img" aria-label="${escape(w.map(x => `Week of ${x.label}: ${number(x.total)} kg external-load tonnage from ${x.count} workouts`).join(". "))}">${w.map(x => `<div class="bar-column"><span class="bar-value">${number(x.total)}</span><div class="bar-track"><div class="bar" style="height:${x.total / max * 100}%"></div></div><span class="bar-label">${x.label}</span></div>`).join("")}</div><p class="chart-caption">Week starting · Monday</p><details class="chart-table"><summary>View chart data</summary><table><caption>External-load tonnage by week</caption><thead><tr><th>Week of</th><th>Workouts</th><th>kg</th></tr></thead><tbody>${w.map(x => `<tr><td>${x.label}</td><td>${x.count}</td><td>${number(x.total)}</td></tr>`).join("")}</tbody></table></details></section>
    <section class="panel analytics-panel"><h2>Estimated strength</h2><p class="small muted">Best eligible set per lift · e1RM, not a tested max.</p>${Object.keys(records).length ? `<ul class="record-list">${Object.entries(records).map(([name, r]) => `<li><div><strong>${escape(name)}</strong><small>${r.set.kg} kg × ${r.set.reps} · ${date(r.date)}${r.set.body ? ` · BW ${r.bw} kg` : ""}</small></div><div class="record-value">${number(r.e1)}<small>kg${r.set.body ? " added" : ""}</small></div></li>`).join("")}</ul>` : `<div class="empty compact"><span class="empty-marker" aria-hidden="true">↗</span><h3>A baseline worth building.</h3><p>Complete and save a compound set of 1–10 reps to see your first estimate.</p></div>`}<details class="methodology"><summary>How estimates work</summary><p>For 2–10 reps: Epley = load × (1 + reps / 30). A single rep uses its actual load. Only valid, ticked compound sets count; this is a rough estimate, not a prediction or a recommendation.</p><p>Pull-ups use added load + that workout's bodyweight, then subtract bodyweight to show estimated added-load capacity. Without a bodyweight snapshot, no estimate is shown. The dip / DB press alternative is excluded because the movement is ambiguous. Legacy apps did not record completion, so legacy sets are excluded.</p></details></section></div>
    <section class="history-section"><div class="section-heading"><h2>Training history</h2><span class="small muted">${hist.length} ${hist.length === 1 ? "workout" : "workouts"}</span></div>${hist.length ? `<div class="history-list">${hist.map(h => `<button class="history-row" data-action="history" data-id="${escape(h.id)}"><span class="history-date">${date(h.date, true)}</span><span class="history-title"><strong>${escape(h.name)}</strong><small>${h.sets.length} ${h.legacy ? "recorded" : "completed"} ${h.sets.length === 1 ? "set" : "sets"} · ${h.legacy ? "Legacy record" : h.partial ? "Partial workout" : "Completed"}${h.durationSeconds !== null ? ` · ${Math.round(h.durationSeconds / 60)} min` : ""}</small></span><span class="history-arrow" aria-hidden="true">↗</span></button>`).join("")}</div>` : `<div class="empty"><span class="empty-marker" aria-hidden="true">↗</span><h3>Your first session starts the story.</h3><p>Finish a workout to keep the sets, notes and check-in here.</p><a class="button primary" href="#train">Go to Train</a></div>`}</section>`;
}
function renderSettings() {
  const p = profile();
  $("#main").innerHTML = `<div class="page-heading"><div><p class="eyebrow">MAKE IT YOURS</p><h1>Settings & your data</h1><p class="muted">A local training space. No accounts, passwords or cloud sync.</p></div></div><div class="settings-layout">
    <section class="panel settings-panel"><h2>Training preferences</h2><p class="small muted">These settings belong to ${escape(p.name)}.</p><label class="form-label">Default bodyweight (kg)<input id="profile-bw" type="number" min="20" max="500" step="any" inputmode="decimal" placeholder="Not recorded" value="${p.bw ?? ""}"></label><p class="small muted">Used for new workouts only. Previous bodyweight snapshots never change.</p><label class="form-label">Rest after completing a set<select id="rest-default">${[[0, "Off"], [60, "1 minute"], [90, "1 min 30 sec"], [120, "2 minutes"], [180, "3 minutes"], [300, "5 minutes"], ...(![0, 60, 90, 120, 180, 300].includes(p.restSeconds) ? [[p.restSeconds, `${p.restSeconds} seconds`]] : [])].map(([value, label]) => `<option value="${value}" ${p.restSeconds === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="form-label">Appearance<select id="appearance">${["light", "dark", "system"].map(t => `<option value="${t}" ${state.theme === t ? "selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></label></section>
    <section class="panel settings-panel"><h2>Local profiles</h2><p>Train alongside your mates. Keep each person's sets, history and check-ins separate.</p><div class="profile-summary"><span class="avatar">${escape(p.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase())}</span><span><strong>${escape(p.name)}</strong><small>${state.profiles.length} local profiles on this device</small></span></div><button class="button secondary" data-action="profiles">Switch or manage profiles</button><p class="privacy-note">Profiles are not sign-ins or private accounts. Anyone with access to this browser can open every profile. Data does not sync between devices, browsers or web addresses.</p></section>
    <section class="panel settings-panel"><h2>Back up & restore</h2><p>Browser data can be cleared or lost. Keep a JSON backup somewhere safe.</p><div class="settings-buttons"><button class="button primary" data-action="export">Export all profiles ↗</button><button class="button secondary" data-action="import">Import a backup</button><button class="text-button" data-action="rollback-export">Download last rollback backup</button></div><p class="small muted">Exports include all profiles, drafts, readiness, bodyweight snapshots and running timer timestamps. A restore asks for confirmation and stores a rollback before replacing anything.</p><p id="import-status" role="status" class="inline-status"></p>${store.locked ? '<button class="button secondary" data-action="recovery-export">Export unreadable recovery data</button>' : ""}</section>
    <section class="panel settings-panel"><h2>Cycle controls</h2><p>Start a fresh cycle for ${escape(p.name)}. Saved workout history is kept.</p><button class="button secondary" data-action="reset-cycle">Start a new cycle</button><p class="small muted">This clears this profile's unfinished drafts, check-ins and rest timers after confirmation. Other profiles are untouched.</p><div class="danger-zone"><h3>Remove this profile</h3><p class="small muted">Deletes this profile's local history and drafts. Export a backup first.</p><button class="button danger-outline" data-action="delete-profile" ${state.profiles.length === 1 ? "disabled" : ""}>Delete ${escape(p.name)}</button>${state.profiles.length === 1 ? '<p class="small muted">The last profile cannot be deleted.</p>' : ""}</div></section>
    ${p.legacy ? `<section class="panel settings-panel legacy-panel"><h2>Legacy data preserved</h2><p>Your old storage keys were left untouched. A full copy also lives inside this profile and every export.</p><ul>${p.legacy.warnings.map(w => `<li>${escape(w)}</li>`).join("")}</ul><button class="button secondary" data-action="legacy-export">Download legacy archive</button></section>` : ""}
    <section class="panel settings-panel"><h2>Install & use offline</h2><p>In your browser menu, choose “Install app” or “Add to Home Screen”. Visit once online to prepare the offline app.</p><p class="small muted">Timers use the clock, so backgrounding or switching profiles does not reset them. Background alerts are not guaranteed; the timer catches up when you return. Close other tabs before editing to avoid conflicts.</p></section>
    </div>`;
}
function renderProfiles() {
  const p = profile();
  showDialog("#profile-dialog", `<div class="dialog-heading"><div><p class="eyebrow">YOUR TRAINING SPACE</p><h2 id="profile-dialog-title">Who's training?</h2></div>${closeButton}</div><p class="dialog-copy">Switch local profiles. Your workout will be right here when you get back.</p>
    <div class="profile-list">${state.profiles.map(person => `<div class="profile-option ${person.id === p.id ? "active" : ""}"><button data-action="switch-profile" data-id="${escape(person.id)}" aria-pressed="${person.id === p.id}"><span class="avatar">${escape(person.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase())}</span><span><strong>${escape(person.name)}</strong><small>${person.history.length} ${person.history.length === 1 ? "workout" : "workouts"} · ${person.id === p.id ? "Active now" : "Local profile"}</small></span><span class="profile-check" aria-hidden="true">${person.id === p.id ? "✓" : "→"}</span></button><button class="rename-button" data-action="rename-profile" data-id="${escape(person.id)}" aria-label="Rename ${escape(person.name)}">Rename</button></div>`).join("")}</div>
    <form id="profile-form" class="profile-form"><label for="profile-name-input">${editProfileId ? "Rename profile" : "Add a profile"}</label><div class="inline-form"><input id="profile-name-input" name="name" maxlength="40" required placeholder="Your mate's name" value="${editProfileId ? escape(state.profiles.find(x => x.id === editProfileId)?.name) : ""}"><button class="button primary" type="submit">${editProfileId ? "Save" : "Add"}</button>${editProfileId ? '<button class="button secondary" type="button" data-action="cancel-rename">Cancel</button>' : ""}</div><p id="profile-form-error" class="field-error" role="alert"></p></form>
    <p class="privacy-note">On this device only. No login, no cloud sync. Profiles organise data; they do not lock it away from other people using this browser.</p>`);
}
function historyDetail(id) {
  const h = profile().history.find(x => x.id === id);
  if (!h) return;
  const groups = [...new Set(h.sets.map(s => s.exercise))];
  showDialog("#detail-dialog", `<div class="dialog-heading"><div><p class="eyebrow">${date(h.date, true)} · ${new Date(h.date).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"})}</p><h2 id="detail-title">${escape(h.name)}</h2></div>${closeButton}</div><div class="detail-summary"><span>${h.legacy ? "Legacy · completion not recorded" : h.partial ? "Partial workout" : "Completed workout"}</span><span>${h.durationSeconds === null ? "Duration not recorded" : `${duration(h.durationSeconds)} elapsed`}</span><span>BW ${h.bwSnapshot === null ? "not recorded" : `${h.bwSnapshot} kg`}</span></div>
    <section class="detail-section"><h3>Check-in</h3><p>${Object.entries(h.readiness).map(([key, value]) => `${key[0].toUpperCase() + key.slice(1)}: ${value === null ? "not recorded" : `${value}/5`}`).join(" · ")}</p></section>
    <section class="detail-section"><h3>Notes</h3><p class="pre-wrap">${escape(h.notes || "No notes recorded.")}</p><p class="small muted">Conditioning: ${escape(h.conditioning || "Not recorded")}</p></section>
    <section class="detail-section"><h3>${h.sets.length} ${h.legacy ? "recorded" : "completed"} ${h.sets.length === 1 ? "set" : "sets"}</h3>${groups.map(name => `<div class="detail-exercise"><h4>${escape(name)}</h4><table><thead><tr><th>Set</th><th>${exerciseFor(name)?.body ? "Added kg" : "kg"}</th><th>Reps</th><th>RPE</th></tr></thead><tbody>${h.sets.filter(s => s.exercise === name).map((s, i) => `<tr><td>${i + 1}</td><td>${s.mobility ? "—" : number(s.kg)}</td><td>${s.mobility ? "Activity" : s.reps}</td><td>${s.rpe ?? "—"}</td></tr>`).join("")}</tbody></table></div>`).join("")}</section><p class="small muted">External-load tonnage: ${number(volume(h))} kg · bodyweight excluded.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Close</button></div>`);
}
function renderRest() {
  const d = profile().drafts[profile().current], dock = $("#rest-dock");
  if (!d?.restEndAt) { dock.hidden = true; return; }
  dock.hidden = false;
  dock.innerHTML = `<div><span class="rest-label">${escape(profile().name)} · REST</span><strong id="rest-clock">${d.restEndAt <= Date.now() ? "Ready" : duration(Math.ceil((d.restEndAt - Date.now()) / 1000))}</strong></div><button data-action="add-rest" class="rest-add">+30s</button><button data-action="cancel-rest" class="rest-cancel" aria-label="Cancel rest timer">×</button>`;
}
function tickClocks() {
  const d = profile().drafts[profile().current];
  if ($("#session-clock")) $("#session-clock").textContent = duration(d?.startedAt ? (Date.now() - d.startedAt) / 1000 : 0);
  if ($("#rest-clock") && d?.restEndAt) {
    const remaining = Math.ceil((d.restEndAt - Date.now()) / 1000);
    const label = remaining > 0 ? duration(remaining) : "Ready";
    if ($("#rest-clock").textContent !== label) {
      $("#rest-clock").textContent = label;
      if (remaining <= 0) toast("Rest complete. Ready when you are.");
    }
  }
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: "application/json"}));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const filename = prefix => `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
function exportAll() { download({...clone(state), exportedAt: new Date().toISOString()}, filename("strength-tracker-all-profiles")); toast("All profiles exported. Keep your backup safe."); }
function finishWorkout() {
  if (finishBusy) return;
  const p = profile(), d = draft(), sets = completedSets(d), total = d.exercises.reduce((n, e) => n + e.sets.length, 0);
  if (!sets.length) { toast("Complete at least one valid set before finishing."); $("#set-summary").textContent = "No completed sets yet. Enter a load and reps, then tick a set."; return; }
  const partial = sets.length < total;
  const savedId = d.id;
  confirmDialog(partial ? "Finish a partial workout?" : "Finish this workout?",
    `${sets.length} of ${total} sets will be saved for ${p.name}. ${partial ? "Unfinished sets in this draft will be discarded. " : ""}Notes, this check-in and the bodyweight snapshot will be kept. Next: ${sessions[wrap(d.session + 1) - 1].name}.`,
    partial ? `Save ${sets.length} completed ${sets.length === 1 ? "set" : "sets"}` : "Save workout", () => {
      if (finishBusy || p.history.some(h => h.id === savedId) || p.drafts[d.session]?.id !== savedId) return;
      finishBusy = true;
      const finishedAt = Date.now();
      p.history.push({id: savedId, date: new Date(finishedAt).toISOString(), session: d.session, cycle: d.cycle,
        name: sessions[d.session - 1].name, startedAt: d.startedAt,
        durationSeconds: d.startedAt === null ? null : Math.max(0, Math.floor((finishedAt - d.startedAt) / 1000)),
        bwSnapshot: d.bwSnapshot, readiness: clone(d.readiness), notes: d.notes, conditioning: d.conditioning, partial, sets});
      if (!p.completed.includes(d.session)) p.completed.push(d.session);
      delete p.drafts[d.session];
      p.current = wrap(d.session + 1);
      if (d.session === 12) { p.cycle++; p.completed = []; }
      const saved = persist();
      openExercises = new Set([0]); render(); finishBusy = false;
      toast(saved ? `${sets.length} ${sets.length === 1 ? "set" : "sets"} saved. Good work, ${p.name.split(" ")[0]}.` : "Workout kept in this tab only. Export it now.");
      window.scrollTo({top: 0, behavior: "instant"});
    });
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const p = profile();
  if (action === "close-dialog") { button.closest("dialog").close(); return; }
  if (action === "confirm") {
    const callback = confirmAction; confirmAction = null;
    $("#confirm-dialog").close(); callback?.(); return;
  }
  if (action === "profiles") { editProfileId = null; renderProfiles(); return; }
  if (action === "switch-profile") {
    state.activeProfileId = button.dataset.id; persist();
    openExercises = new Set([0]); $("#profile-dialog").close(); render();
    toast(`Training as ${profile().name}`); return;
  }
  if (action === "rename-profile") { editProfileId = button.dataset.id; renderProfiles(); $("#profile-name-input").focus(); $("#profile-name-input").select(); return; }
  if (action === "cancel-rename") { editProfileId = null; renderProfiles(); return; }
  if (action === "previous" || action === "next") { goSession(p.current + (action === "next" ? 1 : -1)); return; }
  if (action === "choose-session") { goSession(+button.dataset.session); return; }
  if (action === "accordion") {
    const i = +button.dataset.index;
    openExercises.has(i) ? openExercises.delete(i) : openExercises.add(i);
    button.setAttribute("aria-expanded", openExercises.has(i));
    $(`#exercise-panel-${i}`).hidden = !openExercises.has(i); return;
  }
  if (action === "expand-all") {
    openExercises = openExercises.size === session().ex.length ? new Set() : new Set(session().ex.map((_, i) => i));
    session().ex.forEach((_, i) => updateExercise(i));
    button.textContent = openExercises.size ? "Collapse all" : "Expand all"; return;
  }
  if (action === "add-set") {
    const i = +button.dataset.index, ex = draft().exercises[i];
    if (ex.sets.length >= 100) { toast("Maximum 100 sets per exercise."); return; }
    ex.sets.push(blankSet()); persist(); updateExercise(i);
    $(`[data-testid="set-${i}-${ex.sets.length - 1}-kg"]`)?.focus(); return;
  }
  if (action === "complete-set" || action === "clear-set") {
    const row = button.closest(".set-row"), i = +row.dataset.ex, j = +row.dataset.set, d = draft(), s = d.exercises[i].sets[j], e = session().ex[i];
    if (action === "clear-set") {
      confirmDialog(j >= e.sets ? "Remove this added set?" : "Clear this set?", "This only changes the current draft. Saved workout history will not change.", "Clear set", () => {
        if (j >= e.sets) d.exercises[i].sets.splice(j, 1); else d.exercises[i].sets[j] = blankSet();
        persist(); updateExercise(i);
      }, true); return;
    }
    if (s.done) s.done = false;
    else {
      const error = setError(s, e);
      if (error) { const el = row.querySelector(".set-error"); el.textContent = error; el.hidden = false; row.querySelector("input")?.focus(); return; }
      s.done = true; startSession();
      if (p.restSeconds && e.cat !== "Mobility") d.restEndAt = Date.now() + p.restSeconds * 1000;
    }
    persist(); updateExercise(i, j); renderRest();
    if ($('[data-action="start"]')) { $('[data-action="start"]').disabled = !!d.startedAt; $('[data-action="start"]').textContent = d.startedAt ? "Session in progress" : "Start session timer"; }
    return;
  }
  if (action === "start") { startSession(); persist(); renderTrain(); return; }
  if (action === "finish") { finishWorkout(); return; }
  if (action === "add-rest") { const d = draft(); d.restEndAt = Math.max(Date.now(), d.restEndAt || 0) + 30000; persist(); renderRest(); return; }
  if (action === "cancel-rest") { draft().restEndAt = null; persist(); renderRest(); return; }
  if (action === "theme") { state.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; persist(); theme(); if (view === "settings") renderSettings(); return; }
  if (action === "history") { historyDetail(button.dataset.id); return; }
  if (action === "export") { exportAll(); return; }
  if (action === "import") { $("#import-file").click(); return; }
  if (action === "legacy-export") { download(p.legacy.sources, filename("strength-tracker-legacy-archive")); return; }
  if (action === "recovery-export") { download({previousRaw: store.raw, currentTab: state}, filename("strength-tracker-recovery")); return; }
  if (action === "rollback-export") {
    try {
      const backup = store.rollback();
      if (!backup) { toast("No restore has created a rollback backup yet."); return; }
      // Include unreadable pre-restore bytes in the same download, alongside a directly restorable state.
      download({...backup.state, rollbackRecovery: {previousRaw: backup.previousRaw, rollbackAt: backup.rollbackAt}}, filename("strength-tracker-rollback"));
    }
    catch (error) { toast(error.message); } return;
  }
  if (action === "reset-cycle") {
    confirmDialog("Start a new cycle?", `Clear every unfinished draft, check-in and timer for ${p.name}? Your saved history and the other profiles stay unchanged.`, "Start new cycle", () => {
      p.current = 1; p.cycle++; p.completed = []; p.drafts = {}; persist(); render(); toast("New cycle ready. History kept.");
    }, true); return;
  }
  if (action === "delete-profile" && state.profiles.length > 1) {
    confirmDialog(`Delete ${p.name}?`, "This removes all of this profile's history, drafts and preferences from the current app. Export a backup first. Other profiles and original legacy storage keys are kept.", "Delete profile", () => {
      if (state.profiles.length < 2) return;
      state.profiles = state.profiles.filter(x => x.id !== p.id); state.activeProfileId = state.profiles[0].id;
      persist(); render(); toast("Profile deleted.");
    }, true); return;
  }
  if (action === "update" && waitingWorker) {
    if (!persist()) { toast("Export your work before updating; local saving is unavailable."); return; }
    waitingWorker.postMessage({type: "ACTIVATE_UPDATE"}); return;
  }
});

document.addEventListener("input", event => {
  const input = event.target;
  if (input.matches("[data-field]")) {
    const row = input.closest(".set-row"), i = +row.dataset.ex, j = +row.dataset.set;
    const s = draft().exercises[i].sets[j];
    if (s.done) return;
    s[input.dataset.field] = input.value;
    startSession(); persist();
    row.querySelector(".set-error").hidden = true;
    const start = $('[data-action="start"]');
    if (start) { start.disabled = true; start.textContent = "Session in progress"; }
  }
  if (input.id === "workout-notes") { draft().notes = input.value; persist(); }
});
document.addEventListener("change", async event => {
  const input = event.target, p = profile();
  if (input.dataset.readiness) {
    draft().readiness[input.dataset.readiness] = input.value ? +input.value : null;
    const status = $(".check-in summary .muted");
    if (status) status.textContent = Object.values(draft().readiness).some(v => v !== null) ? "Added ⌄" : "Optional ⌄";
    persist();
  }
  if (input.id === "conditioning") { draft().conditioning = input.value; persist(); }
  if (input.id === "profile-bw" || input.id === "workout-bw") {
    if (input.value !== "" && (!Number.isFinite(+input.value) || +input.value < 20 || +input.value > 500)) {
      input.setCustomValidity("Enter bodyweight from 20–500 kg, or leave it blank."); input.reportValidity(); return;
    }
    input.setCustomValidity("");
    if (input.id === "profile-bw") p.bw = input.value === "" ? null : +input.value;
    else draft().bwSnapshot = input.value === "" ? null : +input.value;
    persist();
  }
  if (input.id === "rest-default") { p.restSeconds = +input.value; persist(); }
  if (input.id === "appearance") { state.theme = input.value; persist(); theme(); }
  if (input.id === "import-file") {
    const file = input.files[0]; input.value = "";
    if (!file || importBusy) return;
    importBusy = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("This backup is larger than the 20 MB safety limit.");
      const imported = parseImport(JSON.parse(await file.text()));
      const targetId = state.activeProfileId;
      confirmDialog(imported.legacy ? "Restore a legacy profile?" : "Replace all local profiles?",
        imported.legacy ? `Replace ${profile().name}'s training data with this original tracker backup? The profile name and other profiles are kept. A local rollback is written first.` : `Replace all ${state.profiles.length} current profiles with ${imported.state.profiles.length} profiles from this backup? Drafts and running timers will also be replaced. A local rollback is written first.`,
        "Restore backup", () => {
          try {
            let next = imported.state;
            if (imported.legacy) {
              next = clone(state);
              const index = next.profiles.findIndex(x => x.id === targetId);
              if (index < 0) throw new Error("The destination profile changed. Choose the backup again.");
              next.profiles[index] = {...imported.state.profiles[0], id: targetId, name: next.profiles[index].name};
              next.activeProfileId = targetId;
            }
            next = validateState(next);
            store.replace(next, state); state = next; openExercises = new Set([0]); render();
            $("#storage-error").hidden = true; $("#save-status").textContent = "Saved on this device";
            if ($("#import-status")) $("#import-status").textContent = "Backup restored. Previous data is available via Download last rollback backup.";
            toast("Backup restored. Rollback saved on this device.");
          } catch (error) { if ($("#import-status")) $("#import-status").textContent = error.message; else toast(error.message); }
        }, true);
    } catch (error) {
      const message = `Import rejected. ${error instanceof SyntaxError ? "The file is not valid JSON." : error.message} No data was changed.`;
      if ($("#import-status")) $("#import-status").textContent = message; else toast(message);
    } finally { importBusy = false; }
  }
});
document.addEventListener("submit", event => {
  if (event.target.id !== "profile-form") return;
  event.preventDefault();
  const name = $("#profile-name-input").value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) { $("#profile-form-error").textContent = "Enter a name, up to 40 characters."; return; }
  if (state.profiles.some(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== editProfileId)) { $("#profile-form-error").textContent = "There is already a profile with that name."; return; }
  if (editProfileId) { state.profiles.find(p => p.id === editProfileId).name = name; editProfileId = null; persist(); render(); renderProfiles(); }
  else {
    if (state.profiles.length >= 50) { $("#profile-form-error").textContent = "A maximum of 50 local profiles is supported."; return; }
    const p = newProfile(name); state.profiles.push(p); state.activeProfileId = p.id;
    persist(); $("#profile-dialog").close(); openExercises = new Set([0]); render(); toast(`Ready for you, ${name}.`);
  }
});
window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
window.addEventListener("storage", e => {
  if (e.key === KEY && e.newValue !== store.raw) {
    store.locked = true; store.problem("Another tab changed your profiles. Saving is paused to protect both versions. Export this tab's work, then reload.");
  }
});
window.addEventListener("beforeunload", event => {
  if (store.failed || store.locked) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", tickClocks);
matchMedia("(prefers-color-scheme:dark)").addEventListener?.("change", theme);
setInterval(tickClocks, 1000);

// A complete, known-asset release waits for explicit activation; never mix network files into a cached release.
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    if (store.failed || store.locked) {
      store.problem("An app update is ready, but this tab has unsaved or conflicting work. Export a backup before reloading.");
      return;
    }
    refreshing = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", {updateViaCache: "none"});
      const announce = worker => { waitingWorker = worker; $("#update-banner").hidden = false; };
      if (registration.waiting) announce(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) announce(worker);
        });
      });
    } catch { /* Some preview/private browser contexts disallow service workers. Training remains usable. */ }
  });
}
render();
