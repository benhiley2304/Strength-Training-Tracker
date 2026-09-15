import {sessions, conditioning, targetReps, exerciseFor} from "./programme.js";
import {APP, KEY, Store, newProfile, newDraft, blankSet, clone, wrap, setError, completedSets, estimate, volume, workloadWeeks, parseImport, validateState} from "./model.js";
import {icon, populateIcons, brandMark} from "./icons.js";
import {CloudStore, api, detectCloud} from "./cloud.js";
import {CLOUD_URL} from "./cloud-config.js";

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
// The static brand and skeleton are already visible before module or network loading.
// This timer only changes presentation; host detection and account checks stay authoritative.
const bootDelay = setTimeout(() => {
  document.body.classList.add('loading-delayed');
  if ($('#boot-title')) $('#boot-title').textContent = 'Taking a little longer';
  if ($('#boot-copy')) $('#boot-copy').textContent = 'Still checking your connection.';
  if ($('#boot-delay')) $('#boot-delay').hidden = false;
}, 8000);
const mode = await detectCloud();
const isCloud = mode !== "local";
let authView = "login", authBusy = false, recoveryOnce = null, recoveryUsername = '', conflictExported = false;
const signedIn = () => !!store.account && !store.sessionExpired;
const emptyAccountState = () => ({app: APP, version: 3, revision: 0, activeProfileId: "signed-out", theme: "light", profiles: [newProfile("Sign in", "signed-out")]});
const store = isCloud ? new CloudStore({
  onState: next => { state = next; openExercises = new Set([0]); if (appReady) render(); },
  onStatus: message => { $("#save-status").textContent = message; updateSyncControls(); },
  onConflict: () => { conflictExported = false; if (appReady) showCloudConflict(); },
  onAuthLost: () => { if (appReady) render(); }
}) : new Store(message => {
  $("#storage-error").textContent = message;
  $("#storage-error").hidden = false;
  $("#save-status").textContent = "Not saved · export a backup";
});
let state = isCloud ? emptyAccountState() : store.load();
let appReady = false;
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
  if (isCloud) return store.save(state);
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
const closeButton = `<button class="icon-button close-dialog" data-action="close-dialog" aria-label="Close dialog">${icon("x")}</button>`;
function confirmDialog(title, message, label, action, danger = false) {
  confirmAction = action;
  showDialog("#confirm-dialog", `<div class="dialog-heading"><h2 id="confirm-title">${escape(title)}</h2>${closeButton}</div><p class="dialog-copy">${escape(message)}</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog" autofocus>Cancel</button><button class="button ${danger ? "danger" : "primary"}" id="confirm-accept" data-action="confirm">${escape(label)}</button></div>`);
}
function theme() {
  const dark = state.theme === "dark" || (state.theme === "system" && matchMedia("(prefers-color-scheme:dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} appearance`);
  $("#theme-toggle").innerHTML = icon(dark ? "sun" : "moon");
}
function render() {
  if (isCloud && !signedIn()) { renderAuth(); return; }
  updateModeChrome();
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
  return `<span class="previous">Previous · ${date(h.date)}${h.legacy ? " · legacy" : ""}<span>${sets.slice(0, 4).map(s => `${number(s.kg)} kg × ${s.reps}`).join(" / ")}${sets.length > 4 ? ` and ${sets.length - 4} more` : ""}</span></span>`;
}
function setHTML(s, i, j, e) {
  const mobility = e.cat === "Mobility";
  return `<div class="set-row ${s.done ? "is-done" : ""}" data-ex="${i}" data-set="${j}">
    <span class="set-number">${j + 1}</span>
    ${mobility ? `<span class="mobility-note">Decompress · no load or reps prescribed</span>` : ["kg", "reps", "rpe"].map(key => {
      const title = key === "kg" ? (e.body ? "Added load kg" : "Load kg") : key === "reps" ? "Reps" : "RPE (optional)";
      return `<label class="set-field"><span class="sr-only">${escape(e.name)} set ${j + 1} ${title}</span><input data-field="${key}" data-testid="set-${i}-${j}-${key}" type="number" inputmode="${key === "reps" ? "numeric" : "decimal"}" min="${key === "reps" || key === "rpe" ? 1 : 0}" max="${key === "reps" ? 200 : key === "rpe" ? 10 : 1500}" step="${key === "reps" ? 1 : key === "rpe" ? 0.5 : "any"}" value="${escape(s[key])}" placeholder="${key === "reps" ? targetReps(e, j) : key === "kg" ? "—" : "—"}" ${s.done ? "readonly" : ""}></label>`;
    }).join("")}
    <button class="complete-set ${s.done ? "checked" : ""}" data-action="complete-set" data-testid="complete-${i}-${j}" aria-pressed="${s.done}" aria-label="${s.done ? "Unmark" : "Complete"} ${escape(e.name)} set ${j + 1}">${icon("check")}</button>
    <button class="set-more" data-action="clear-set" title="${j >= e.sets ? "Remove added set" : "Clear set"}" aria-label="${j >= e.sets ? "Remove added" : "Clear"} ${escape(e.name)} set ${j + 1}">${icon("x")}</button>
    <p class="set-error" aria-live="polite" hidden></p>
  </div>`;
}
function exerciseHTML(e, i) {
  const d = draft().exercises[i], done = d.sets.filter(s => s.done && !setError(s, e)).length;
  return `<article class="exercise ${done === d.sets.length ? "exercise-complete" : ""}" data-exercise="${i}">
    <h2><button class="exercise-toggle" data-action="accordion" data-index="${i}" aria-expanded="${openExercises.has(i)}" aria-controls="exercise-panel-${i}" id="exercise-heading-${i}">
      <span class="exercise-index">${String(i + 1).padStart(2, "0")}</span><span class="exercise-title"><span>${escape(e.name)}</span><small>${escape(e.cat)} <span aria-hidden="true">·</span> ${e.sets} × ${e.reps}</small></span>
      <span class="exercise-counter">${done}/${d.sets.length}</span><span class="chevron">${icon("chevron-down")}</span>
    </button></h2>
    <div class="exercise-panel" id="exercise-panel-${i}" role="region" aria-labelledby="exercise-heading-${i}" ${openExercises.has(i) ? "" : "hidden"}>
      ${previousHTML(e.name)}
      ${e.body ? '<p class="load-hint">Log added weight only; 0 = bodyweight. Workout bodyweight is snapshotted for estimates.</p>' : e.name === "Weighted Dip / Flat DB Press" ? '<p class="load-hint">Dip: added load. DB press: combined dumbbell load. Note which you did; this mixed movement has no e1RM estimate.</p>' : ""}
      <div class="set-labels" aria-hidden="true"><span>Set</span>${e.cat === "Mobility" ? '<span class="mobility-note">Activity</span>' : `<span>${e.body ? "Added kg" : "kg"}</span><span>Reps</span><span>RPE <small>opt.</small></span>`}<span>Done</span><span></span></div>
      <div class="set-list">${d.sets.map((s, j) => setHTML(s, i, j, e)).join("")}</div>
      <div class="exercise-foot"><button class="text-button" data-action="add-set" data-index="${i}">${icon("plus")} Add set</button></div>
    </div>
  </article>`;
}
function readinessHTML(d) {
  return `<details class="panel check-in"><summary><span>Session check-in</span><span class="muted"><span class="readiness-status">${Object.values(d.readiness).some(v => v !== null) ? "Added" : "Optional"}</span><span class="chevron">${icon("chevron-down")}</span></span></summary><div class="panel-body">
    <p class="small muted">How are you arriving? 1 = low / poor, 5 = high / good. Joints: 5 = comfortable.</p>
    <div class="readiness-fields">${["energy", "sleep", "joints"].map(key => `<label>${key[0].toUpperCase() + key.slice(1)}<select data-readiness="${key}" aria-label="${key} readiness"><option value="">Not recorded</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${d.readiness[key] === n ? "selected" : ""}>${n} / 5</option>`).join("")}</select></label>`).join("")}</div>
    <label class="form-label">Bodyweight for this workout (kg)<input id="workout-bw" type="number" min="20" max="500" step="any" inputmode="decimal" value="${d.bwSnapshot ?? ""}" placeholder="Not recorded"></label><p class="small muted">This snapshot stays with this workout. Change your default in Settings.</p>
  </div></details>`;
}
function renderTrain() {
  const p = profile(), s = session(), d = draft();
  const done = completedSets(d).length, total = d.exercises.reduce((n, e) => n + e.sets.length, 0);
  $("#main").innerHTML = `<div class="page-heading"><div><h1>Today’s workout</h1></div><span class="cycle-label">Cycle ${String(p.cycle).padStart(2, "0")}</span></div>
    <section class="session-banner" aria-label="Current session"><div class="session-banner-top"><span class="eyebrow">Session ${String(s.id).padStart(2, "0")} <span class="quiet">/ 12</span></span><div class="session-arrows"><button data-action="previous" aria-label="Previous session">${icon("arrow-left")}</button><button data-action="next" aria-label="Next session">${icon("arrow-right")}</button></div></div><div class="session-banner-title"><div><h2>${s.name}</h2><p>${s.focus}</p></div><span class="intensity ${s.intensity}">${s.intensity}</span></div><div class="session-banner-bottom"><span>${s.ex.length} exercises <span class="quiet">/</span> ${total} sets</span><a href="#programme">View programme ${icon("arrow-right")}</a></div></section>
    <div class="workout-layout"><section class="exercise-column" aria-label="Workout exercises"><div class="section-heading"><h2>Workout</h2><button class="text-button" data-action="expand-all">${openExercises.size === s.ex.length ? "Collapse all" : "Expand all"}</button></div><p class="workout-help">Enter your load and reps, then tick each finished set. RPE is optional.</p><div id="exercises">${s.ex.map(exerciseHTML).join("")}</div></section>
    <aside class="workout-aside" aria-label="Session tools">
      <section class="panel session-status"><div class="section-heading"><h2>Session progress</h2><span id="session-percent">${Math.round(done / total * 100)}%</span></div><progress id="session-progress" value="${done}" max="${total}" aria-label="Completed sets"></progress><p id="set-summary">${done} of ${total} sets complete</p><div class="clock-row"><span>Elapsed time</span><strong id="session-clock">${duration(d.startedAt ? (Date.now() - d.startedAt) / 1000 : 0)}</strong></div><button class="button secondary full" data-action="start" ${d.startedAt ? "disabled" : ""}>${d.startedAt ? "Session in progress" : "Start session timer"}</button><button id="finish-workout" class="button primary full" data-action="finish">Finish workout ${icon("arrow-right")}</button><p class="small muted">Only completed, valid sets are saved.</p></section>
      ${readinessHTML(d)}
      <details class="panel"><summary><span>Notes & conditioning</span><span class="chevron">${icon("chevron-down")}</span></summary><div class="panel-body"><label class="form-label">Session notes<textarea id="workout-notes" rows="3" maxlength="10000" placeholder="How did it feel? Any substitutions?">${escape(d.notes)}</textarea></label><label class="form-label">Conditioning<select id="conditioning">${[...new Set([...conditioning, d.conditioning])].map(c => `<option ${c === d.conditioning ? "selected" : ""}>${escape(c)}</option>`).join("")}</select></label></div></details>
      <section class="coach-note"><span class="eyebrow">Session guidance</span><p>${s.intensity === "heavy" ? "Take full rests. Leave a clean rep in reserve." : s.intensity === "medium" ? "Build crisp volume without grinding." : "Move well, own every rep, and recover for the next exposure."}</p></section>
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
  $("#main").innerHTML = `<div class="page-heading"><div><h1>Programme</h1><p class="muted">12 sessions. Upper / lower. Heavy / medium / light. Follow the sequence at your own pace.</p></div></div>
    <div class="programme-overview"><div><span class="eyebrow">Cycle ${String(p.cycle).padStart(2, "0")}</span><p><strong>${p.completed.length}</strong> / 12 sessions logged this cycle</p></div><span class="small muted">Partial workouts count as logged, not fully completed.</span></div>
    <div class="programme-grid">${sessions.map(s => `<article class="plan-session ${s.id === p.current ? "current" : ""}"><div class="plan-top"><span class="plan-number">${String(s.id).padStart(2, "0")}</span><span class="intensity ${s.intensity}">${s.intensity}</span><span class="plan-state">${s.id === p.current ? "Current" : p.completed.includes(s.id) ? "Logged" : ""}</span></div><h2>${s.name}</h2><p>${s.focus}</p><details class="prescriptions"><summary><span>${s.ex.length} exercises · Prescriptions</span><span class="chevron">${icon("chevron-down")}</span></summary><ul>${s.ex.map(e => `<li><span>${escape(e.name)}</span><strong>${e.sets} × ${e.reps}</strong></li>`).join("")}</ul></details><button class="button ${s.id === p.current ? "primary" : "secondary"} full" data-action="choose-session" data-session="${s.id}">${s.id === p.current ? "Continue session" : "Open session"} ${icon("arrow-right")}</button></article>`).join("")}</div>
    <p class="small muted section-note">Browsing wraps from 12 to 1 without changing your cycle. Finishing session 12 begins the next cycle. Training drafts stay attached to their session until saved or explicitly cleared.</p>`;
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
  $("#main").innerHTML = `<div class="page-heading"><div><h1>Training progress</h1><p class="muted">Workout history and strength estimates for ${escape(p.name)}.</p></div></div>
    <div class="metrics"><div><span>Workouts logged</span><strong>${hist.length}</strong></div><div><span>Verified completed sets</span><strong>${count}</strong></div><div><span>Current cycle logged</span><strong>${p.completed.length}<small> / 12</small></strong></div></div>
    <div class="progress-layout"><section class="panel analytics-panel"><div class="section-heading"><h2>Four-week workload</h2><span class="small muted">kg · external load</span></div><p class="small muted">Load × reps as entered. Bodyweight is excluded. Legacy recorded sets included; not a measure of effort.</p><div class="bar-chart" role="img" aria-label="${escape(w.map(x => `Week of ${x.label}: ${number(x.total)} kg external-load tonnage from ${x.count} workouts`).join(". "))}">${w.map(x => `<div class="bar-column"><span class="bar-value">${number(x.total)}</span><div class="bar-track"><div class="bar" style="height:${x.total / max * 100}%"></div></div><span class="bar-label">${x.label}</span></div>`).join("")}</div><p class="chart-caption">Week starting · Monday</p><details class="chart-table"><summary><span>View chart data</span><span class="chevron">${icon("chevron-down")}</span></summary><table><caption>External-load tonnage by week</caption><thead><tr><th>Week of</th><th>Workouts</th><th>kg</th></tr></thead><tbody>${w.map(x => `<tr><td>${x.label}</td><td>${x.count}</td><td>${number(x.total)}</td></tr>`).join("")}</tbody></table></details></section>
    <section class="panel analytics-panel"><h2>Estimated strength</h2><p class="small muted">Best eligible set per lift · e1RM, not a tested max.</p>${Object.keys(records).length ? `<ul class="record-list">${Object.entries(records).map(([name, r]) => `<li><div><strong>${escape(name)}</strong><small>${r.set.kg} kg × ${r.set.reps} · ${date(r.date)}${r.set.body ? ` · BW ${r.bw} kg` : ""}</small></div><div class="record-value">${number(r.e1)}<small>kg${r.set.body ? " added" : ""}</small></div></li>`).join("")}</ul>` : `<div class="empty compact"><h3>No strength estimates yet</h3><p>Complete and save a compound set of 1–10 reps to see your first estimate.</p></div>`}<details class="methodology"><summary><span>How estimates work</span><span class="chevron">${icon("chevron-down")}</span></summary><p>For 2–10 reps: Epley = load × (1 + reps / 30). A single rep uses its actual load. Only valid, ticked compound sets count; this is a rough estimate, not a prediction or a recommendation.</p><p>Pull-ups use added load + that workout's bodyweight, then subtract bodyweight to show estimated added-load capacity. Without a bodyweight snapshot, no estimate is shown. The dip / DB press alternative is excluded because the movement is ambiguous. Legacy apps did not record completion, so legacy sets are excluded.</p></details></section></div>
    <section class="history-section"><div class="section-heading"><h2>Training history</h2><span class="small muted">${hist.length} ${hist.length === 1 ? "workout" : "workouts"}</span></div>${hist.length ? `<div class="history-list">${hist.map(h => `<button class="history-row" data-action="history" data-id="${escape(h.id)}"><span class="history-date">${date(h.date, true)}</span><span class="history-title"><strong>${escape(h.name)}</strong><small>${h.sets.length} ${h.legacy ? "recorded" : "completed"} ${h.sets.length === 1 ? "set" : "sets"} · ${h.legacy ? "Legacy record" : h.partial ? "Partial workout" : "Completed"}${h.durationSeconds !== null ? ` · ${Math.round(h.durationSeconds / 60)} min` : ""}</small></span><span class="history-arrow">${icon("chevron-right")}</span></button>`).join("")}</div>` : `<div class="empty"><h3>No workouts logged yet</h3><p>Finish a workout to keep the sets, notes and check-in here.</p><a class="button primary" href="#train">Go to Train ${icon("arrow-right")}</a></div>`}</section>`;
}
function renderSettings() {
  const p = profile();
  $("#main").innerHTML = `<div class="page-heading"><div><h1>Settings</h1><p class="muted">${isCloud ? "Your account, training preferences and backups." : "Training preferences, local profiles and backups."}</p></div></div><div class="settings-layout">
    <section class="panel settings-panel"><h2>Training preferences</h2><p class="small muted">These settings belong to ${escape(p.name)}.</p><label class="form-label">Default bodyweight (kg)<input id="profile-bw" type="number" min="20" max="500" step="any" inputmode="decimal" placeholder="Not recorded" value="${p.bw ?? ""}"></label><p class="small muted">Used for new workouts only. Previous bodyweight snapshots never change.</p><label class="form-label">Rest after completing a set<select id="rest-default">${[[0, "Off"], [60, "1 minute"], [90, "1 min 30 sec"], [120, "2 minutes"], [180, "3 minutes"], [300, "5 minutes"], ...(![0, 60, 90, 120, 180, 300].includes(p.restSeconds) ? [[p.restSeconds, `${p.restSeconds} seconds`]] : [])].map(([value, label]) => `<option value="${value}" ${p.restSeconds === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="form-label">Appearance<select id="appearance">${["light", "dark", "system"].map(t => `<option value="${t}" ${state.theme === t ? "selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}</select></label></section>
    ${isCloud ? cloudAccountSettings() : `<section class="panel settings-panel"><h2>Local profiles</h2><p>Train alongside your mates. Keep each person's sets, history and check-ins separate.</p><div class="profile-summary"><span class="avatar">${escape(p.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase())}</span><span><strong>${escape(p.name)}</strong><small>${state.profiles.length} local profiles on this device</small></span></div><button class="button secondary" data-action="profiles">Switch or manage profiles</button><p class="privacy-note">Profiles are not sign-ins or private accounts. Anyone with access to this browser can open every profile. Data does not sync between devices, browsers or web addresses.</p></section>`}
    <section class="panel settings-panel"><h2>Back up & restore</h2><p>Browser data can be cleared or lost. Keep a JSON backup somewhere safe.</p><div class="settings-buttons"><button class="button primary" data-action="export">${isCloud ? "Export this account" : "Export all profiles"} ${icon("download")}</button><button class="button secondary" data-action="import">Import a backup ${icon("upload")}</button><button class="text-button" data-action="rollback-export">Download last rollback backup</button></div><p class="small muted">${isCloud ? "Exports contain only this account. Importing a multi-profile backup asks you to choose exactly one person; nobody else is uploaded. A device rollback is saved first. Imports replace, not merge." : "Exports include all profiles, drafts, readiness, bodyweight snapshots and running timer timestamps. A restore asks for confirmation and stores a rollback before replacing anything."}</p><p id="import-status" role="status" class="inline-status"></p>${store.locked ? '<button class="button secondary" data-action="recovery-export">Export unreadable recovery data</button>' : ""}</section>
    <section class="panel settings-panel"><h2>Cycle controls</h2><p>Start a fresh cycle for ${escape(p.name)}. Saved workout history is kept.</p><button class="button secondary" data-action="reset-cycle">Start a new cycle</button><p class="small muted">This clears this profile's unfinished drafts, check-ins and rest timers after confirmation. Other profiles are untouched.</p>${isCloud ? "" : `<div class="danger-zone"><h3>Remove this profile</h3><p class="small muted">Deletes this profile's local history and drafts. Export a backup first.</p><button class="button danger-outline" data-action="delete-profile" ${state.profiles.length === 1 ? "disabled" : ""}>Delete ${escape(p.name)}</button>${state.profiles.length === 1 ? '<p class="small muted">The last profile cannot be deleted.</p>' : ""}</div>`}</section>
    ${p.legacy ? `<section class="panel settings-panel legacy-panel"><h2>Legacy data preserved</h2><p>Your old storage keys were left untouched. A full copy also lives inside this profile and every export.</p><ul>${p.legacy.warnings.map(w => `<li>${escape(w)}</li>`).join("")}</ul><button class="button secondary" data-action="legacy-export">Download legacy archive</button></section>` : ""}
    <section class="panel settings-panel"><h2>Install & use offline</h2><p>In your browser menu, choose “Install app” or “Add to Home Screen”. ${isCloud ? "Sign in online first. An already-open account can keep changes while offline; reopening requires a server session check. The device cache is not encrypted, so use a trusted browser." : "Visit once online to prepare the offline app."}</p><p class="small muted">Timers use the clock, so backgrounding or switching profiles does not reset them. Background alerts are not guaranteed; the timer catches up when you return. Close other tabs before editing to avoid conflicts.</p></section>
    </div>`;
}
function renderProfiles() {
  if (isCloud) { renderAccount(); return; }
  const p = profile();
  showDialog("#profile-dialog", `<div class="dialog-heading"><div><h2 id="profile-dialog-title">Local profiles</h2></div>${closeButton}</div><p class="dialog-copy">Switch profiles. Your current workout stays saved on this device.</p>
    <div class="profile-list">${state.profiles.map(person => `<div class="profile-option ${person.id === p.id ? "active" : ""}"><button data-action="switch-profile" data-id="${escape(person.id)}" aria-pressed="${person.id === p.id}"><span class="avatar">${escape(person.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase())}</span><span><strong>${escape(person.name)}</strong><small>${person.history.length} ${person.history.length === 1 ? "workout" : "workouts"} · ${person.id === p.id ? "Active now" : "Local profile"}</small></span><span class="profile-check">${icon(person.id === p.id ? "check" : "arrow-right")}</span></button><button class="rename-button" data-action="rename-profile" data-id="${escape(person.id)}" aria-label="Rename ${escape(person.name)}">Rename</button></div>`).join("")}</div>
    <form id="profile-form" class="profile-form"><label for="profile-name-input">${editProfileId ? "Rename profile" : "Add a profile"}</label><div class="inline-form"><input id="profile-name-input" name="name" maxlength="40" required placeholder="Your mate's name" value="${editProfileId ? escape(state.profiles.find(x => x.id === editProfileId)?.name) : ""}"><button class="button primary" type="submit">${editProfileId ? "Save" : "Add"}</button>${editProfileId ? '<button class="button secondary" type="button" data-action="cancel-rename">Cancel</button>' : ""}</div><p id="profile-form-error" class="field-error" role="alert"></p></form>
    <p class="privacy-note">On this device only. No login or automatic sync. Profiles organise data; they do not lock it away from other people using this browser.</p>`);
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
  dock.innerHTML = `<div><span class="rest-label">${escape(profile().name)} · Rest</span><strong id="rest-clock">${d.restEndAt <= Date.now() ? "Ready" : duration(Math.ceil((d.restEndAt - Date.now()) / 1000))}</strong></div><button data-action="add-rest" class="rest-add" aria-label="Add 30 seconds rest">${icon("plus")}30s</button><button data-action="cancel-rest" class="rest-cancel" aria-label="Cancel rest timer">${icon("x")}</button>`;
}
function tickClocks() {
  if (isCloud && !signedIn()) return;
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
function exportAll() { download({...clone(state), exportedAt: new Date().toISOString()}, filename(isCloud ? "strength-tracker-account" : "strength-tracker-all-profiles")); toast(isCloud ? "This account exported. Keep your backup safe." : "All local profiles exported, including every person on this browser. Keep this file private."); }
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
      if (isCloud) void store.flush();
      openExercises = new Set([0]); render(); finishBusy = false;
      toast(isCloud ? "Workout kept on this device · check sync status before closing." : saved ? `${sets.length} ${sets.length === 1 ? "set" : "sets"} saved. Good work, ${p.name.split(" ")[0]}.` : "Workout kept in this tab only. Export it now.");
      window.scrollTo({top: 0, behavior: "instant"});
    });
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'toggle-password') {
    const input = document.getElementById(button.dataset.passwordFor);
    if (!input || !['password', 'text'].includes(input.type)) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${button.dataset.passwordLabel.toLowerCase()}`);
    button.innerHTML = `${icon(show ? 'eye-off' : 'eye')}<span>${show ? 'Hide' : 'Show'}</span>`;
    return;
  }
  if (isCloud && handleCloudClick(button)) return;
  if (!isCloud && action === "launch-cloud") { launchCloud(); return; }
  if (isCloud && !signedIn() && !["close-dialog", "confirm"].includes(action)) return;
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
    persist(); if (isCloud) void store.flush(); updateExercise(i, j); renderRest();
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
    if (isCloud && (store.dirty || store.inflight)) { toast("Wait for sync, or export pending work before reloading."); return; }
    if (!persist()) { toast("Export your work before updating; local saving is unavailable."); return; }
    waitingWorker.postMessage({type: "ACTIVATE_UPDATE"}); return;
  }
});

document.addEventListener("input", event => {
  if (isCloud && !signedIn()) return;
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
  if (isCloud && !signedIn()) return;
  const input = event.target, p = profile();
  if (input.dataset.readiness) {
    draft().readiness[input.dataset.readiness] = input.value ? +input.value : null;
    const status = $(".check-in summary .readiness-status");
    if (status) status.textContent = Object.values(draft().readiness).some(v => v !== null) ? "Added" : "Optional";
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
      if (isCloud) { chooseCloudImport(imported.state); return; }
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
  if (event.target.id !== "profile-form" || isCloud) return;
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
  if (isCloud) { store.storageChanged(e); return; }
  if (e.key === KEY && e.newValue !== store.raw) {
    store.locked = true; store.problem("Another tab changed your profiles. Saving is paused to protect both versions. Export this tab's work, then reload.");
  }
});
window.addEventListener("beforeunload", event => {
  if (store.failed || store.locked || (isCloud && store.dirty)) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", tickClocks);
matchMedia("(prefers-color-scheme:dark)").addEventListener?.("change", theme);
setInterval(tickClocks, 1000);

// A complete, known-asset release waits for explicit activation; never mix network files into a cached release.
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    if (store.failed || store.locked || (isCloud && store.dirty)) {
      store.problem("An app update is ready, but this tab has unsaved or conflicting work. Export a backup before reloading.");
      return;
    }
    refreshing = true;
    location.reload();
  });
  const registerWorker = async () => {
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
  };
  if (document.readyState === "complete") void registerWorker();
  else window.addEventListener("load", registerWorker, {once: true});
}
populateIcons();
updateModeChrome();
if (isCloud) {
  if ($("#boot-copy")) $("#boot-copy").textContent = "Checking your account. Your local profiles stay separate.";
  if (mode === "cloud") await store.boot();
  else store.status("Connection unavailable · retry when online. No data has been reset.");
  window.addEventListener("focus", () => void store.refresh());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void store.refresh(); });
  window.addEventListener("online", () => { if (store.dirty) void store.flush(); else void store.refresh(); });
  window.addEventListener("offline", () => { if (signedIn()) store.status("Offline · changes stay on this device until sync succeeds"); });
  setInterval(() => { if (document.visibilityState === "visible") void store.refresh(); }, 45000);
}
clearTimeout(bootDelay);
document.body.classList.remove('is-loading', 'loading-delayed');
appReady = true;
if (!isCloud && !store.failed && !store.locked) $("#save-status").textContent = "On this device · ready to train";
render();
if (isCloud && store.conflict) showCloudConflict();

// Cloud-only UI is kept alongside the existing local UI. Local profiles are never a cloud account picker.
function updateModeChrome() {
  $('.app-shell').classList.toggle('cloud-mode', isCloud);
  document.body.classList.toggle('signed-out', isCloud && !signedIn());
  if (isCloud && $('.topbar').nextElementSibling !== $('.app-footer')) $('.topbar').after($('.app-footer'));
  if ($('#cloud-launch-banner')) $('#cloud-launch-banner').hidden = isCloud || !validCloudURL();
  if (isCloud) {
    $('#profile-button small').textContent = signedIn() ? 'Your account' : 'Sign in';
    $('.sidebar-bottom').innerHTML = `Your account<p>Same sign-in on phone & desktop.<br>Your training, kept in sync.</p><button class="sidebar-export" data-action="${signedIn() ? 'export' : 'cloud-local-export'}">${signedIn() ? 'Export this account' : 'Export existing local backup'} ${icon('download')}</button>`;
  } else {
    $('#profile-button small').textContent = 'On this device';
    if (validCloudURL()) $('.sidebar-bottom').innerHTML = `On this device<p>No account. No automatic uploads.<br>This address stays local.</p><button class="sidebar-export" data-action="export">Export all local profiles ${icon('download')}</button><button class="sidebar-export cloud-launch" data-action="launch-cloud">Use synced tracker ${icon('arrow-right')}</button>`;
  }
  updateSyncControls();
}
function updateSyncControls() {
  const el = $('#sync-actions');
  if (!el || !isCloud) return;
  el.innerHTML = !store?.account ? '' : `<button class="text-button" data-action="${store.locked ? 'cloud-conflict' : 'cloud-retry'}">${store.locked ? 'Resolve conflict' : store.dirty || store.failed ? 'Retry sync' : 'Refresh'}</button>`;
}
function validCloudURL() { try { const url = new URL(CLOUD_URL); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } }
function launchCloud() {
  if (!validCloudURL()) return;
  confirmDialog('Use the synced tracker', 'First download a backup containing ALL local users on this browser, including your mates. Keep it private. The synced tracker opens separately; sign in and explicitly choose exactly one profile to import. Nothing uploads from this local address.', 'Export all profiles & continue', () => { exportAll(); window.open(validCloudURL(), '_blank', 'noopener,noreferrer'); });
}
function passwordField({id, name = 'password', label = 'Password', autocomplete = 'current-password', hint = ''}) {
  return `<div class="password-field"><label class="form-label" for="${id}">${label}</label><div class="password-input"><input name="${name}" id="${id}" type="password" autocomplete="${autocomplete}" minlength="12" maxlength="128" ${hint ? `aria-describedby="${hint}"` : ''} required><button type="button" class="password-toggle" data-action="toggle-password" data-password-for="${id}" data-password-label="${label}" data-testid="toggle-${id}" aria-controls="${id}" aria-label="Show ${label.toLowerCase()}" aria-pressed="false">${icon('eye')}<span>Show</span></button></div></div>`;
}
function renderAuth() {
  updateModeChrome();
  $('#profile-name').textContent = 'Sign in'; $('#profile-avatar').textContent = '—'; $('#rest-dock').hidden = true;
  $('#view-label').textContent = 'Account'; document.title = `Account · ${APP}`;
  const signup = authView === 'signup', reset = authView === 'recover';
  $('#main').innerHTML = `<div class="auth-screen" data-testid="account-landing">
    <div class="auth-brand">${brandMark(48)}<span class="brand-name">Strength Training <span>Tracker</span></span></div>
    <section class="panel auth-panel" aria-labelledby="auth-title">
    <div class="auth-heading"><div><h1 id="auth-title">${signup ? 'Create your account' : reset ? 'Reset your password' : 'Welcome back'}</h1><p class="muted">${signup ? 'Your training. One account. Every device.' : reset ? 'Use the recovery code you saved.' : 'Pick up where you left off.'}</p></div><div class="auth-bars" aria-hidden="true"><span></span><span></span><span></span></div></div>
    ${mode !== 'cloud' || store.failed || /cleanup failed/.test(store.message || '') ? `<div class="auth-connection" role="status"><p>${escape(store.message || 'Connection unavailable. Your data has not been reset.')}</p><button class="text-button" data-action="cloud-reload">Retry connection</button></div>` : ''}
    ${store.sessionExpired ? '<p class="privacy-note">Your session has expired. Sign in again to continue. Export any unsynced work before leaving.</p>' : ''}
    ${reset ? '<p class="privacy-note" id="recovery-help">There is no email recovery. Enter your username and saved recovery code below. Without the code, you cannot reset your password here. Resetting signs out all devices and replaces your recovery code.</p>' : ''}
    <form id="cloud-auth-form" class="cloud-form" data-testid="auth-form">
      <div class="auth-field"><label class="form-label" for="auth-username">Username</label><input name="username" id="auth-username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" ${signup ? 'aria-describedby="username-hint"' : ''} required placeholder="your_username">${signup ? '<p id="username-hint" class="field-hint">3–32 letters, numbers, underscores or hyphens.</p>' : ''}</div>
      ${signup ? '<div class="auth-field"><label class="form-label" for="auth-name">Display name</label><input name="name" id="auth-name" autocomplete="nickname" maxlength="40" required placeholder="Your name"></div><div class="auth-field"><label class="form-label" for="auth-invite">Invite code</label><input name="inviteCode" id="auth-invite" type="password" autocomplete="off" minlength="12" maxlength="256" aria-describedby="invite-hint" required><p id="invite-hint" class="field-hint">Ask your host for an invitation code.</p></div>' : ''}
      ${reset ? '<label class="form-label">Recovery code<input name="recoveryCode" id="auth-recovery" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" aria-describedby="recovery-help" required></label>' : ''}
      ${passwordField({id: 'auth-password', label: reset ? 'New password' : 'Password', autocomplete: signup || reset ? 'new-password' : 'current-password', hint: signup || reset ? 'password-hint' : ''})}
      ${signup || reset ? '<p id="password-hint" class="field-hint">12–128 characters. Choose a unique password.</p>' : ''}
      ${signup ? '<p class="field-hint">Next, save your recovery code. It is the only way to reset a forgotten password.</p>' : ''}
      <p id="auth-error" class="field-error" role="alert"></p>
      <p id="auth-progress" class="field-hint" role="status" hidden></p>
      <button class="button primary" type="submit" data-testid="auth-submit">${signup ? 'Create account' : reset ? 'Reset password' : 'Sign in'}</button>
    </form>
    <div class="auth-links">${signup || reset ? '<button class="text-button" data-action="cloud-auth-login">Back to sign in</button>' : '<button class="text-button" data-action="cloud-auth-signup">Create account</button><button class="text-button" data-action="cloud-auth-recover">Forgot password</button>'}</div>
    ${store.sessionExpired && store.dirty ? '<button class="button secondary" data-action="cloud-pending-export">Export unsynced account work</button>' : ''}
    <details class="local-migration-note"><summary>Existing local training data? ${icon('chevron-down')}</summary><p class="small muted">Your old local tracker remains separate and usable. Export a backup there, then sign in here and use Settings → Import a backup. You must choose exactly one profile. Files labelled “all profiles” include everyone on that browser; keep them private.</p><button class="text-button" data-action="cloud-local-export">Export this browser’s local-only backup (all local users)</button></details>
    </section><p class="auth-footnote">Your own username and password. The same on every device.</p></div>`;
}
function cloudAccountSettings() {
  return `<section class="panel settings-panel"><h2>Your account</h2><p><strong>${escape(profile().name)}</strong><br><span class="small muted">@${escape(store.account.username)} · this account only</span></p><button class="button secondary" data-action="profiles">Account & sign-in settings</button><p class="privacy-note">Other people's accounts cannot be opened from this menu. Sign out, then use their own credentials. Browser snapshots are not encrypted; only use a trusted device. Signing out clears this account's cache and rollback, after you have exported pending changes.</p><details class="storage-details"><summary>How your data is stored ${icon('chevron-down')}</summary><p class="small muted">Private GitHub storage is maintained by the app operator; it is not end-to-end encrypted. Keep your own exports. The service sleeps when idle and may take around a minute to wake.</p></details></section>`;
}
function renderAccount() {
  if (!signedIn()) { renderAuth(); return; }
  showDialog('#profile-dialog', `<div class="dialog-heading"><h2 id="profile-dialog-title">Your account</h2>${closeButton}</div><p class="dialog-copy">@${escape(store.account.username)} · your account<br>Only your training data is available here.</p>
    <form id="cloud-name-form" class="cloud-form"><label class="form-label">Display name<input id="cloud-name" name="name" maxlength="40" required value="${escape(profile().name)}"></label><button class="button primary" type="submit">Save name</button></form>
    <details><summary>Change password</summary><form id="cloud-password-form" class="cloud-form">${passwordField({id: 'account-current-password', name: 'currentPassword', label: 'Current password'})}${passwordField({id: 'account-new-password', label: 'New password', autocomplete: 'new-password'})}<p class="small muted">Signs out other devices. Your saved recovery code remains valid.</p><button class="button secondary" type="submit">Change password</button><p id="password-status" class="field-error" role="status"></p></form></details>
    <div class="dialog-actions"><button class="button secondary" data-action="cloud-settings">Training settings</button><button class="button secondary" data-action="cloud-logout">Sign out</button></div><p class="privacy-note">Use a private browser session on shared devices. Downloaded backups remain outside the app and must be removed separately.</p>`);
}
function showRecovery(code, username) {
  recoveryOnce = code; recoveryUsername = username || store.account?.username || ''; 
  showDialog('#cloud-dialog', `<div class="dialog-heading"><h2 id="cloud-title">Save your recovery code now</h2></div><p class="dialog-copy">This code is displayed once. Store it in your password manager, separately from your password. There is no email recovery. A password reset replaces this code.</p><code class="recovery-code" id="recovery-code">${escape(code)}</code><div class="dialog-actions"><button class="button secondary" data-action="cloud-recovery-download">Download recovery code</button><button class="button primary" data-action="cloud-recovery-done">I have stored this code</button></div>`);
}
async function showCloudConflict() {
  if (!store.account) return;
  try {
    const latest = store.conflict || await store.latestConflict();
    const p = profile(), remote = latest.profile;
    showDialog('#cloud-dialog', `<div class="dialog-heading"><h2 id="cloud-title">Choose which version to keep</h2>${closeButton}</div><p class="dialog-copy">No changes have been overwritten. Versions are not merged automatically. Export this tab first, then choose deliberately. A newer timestamp does not necessarily contain every workout.</p><div class="conflict-compare"><section><h3>This device</h3><p>${p.history.length} workouts · session ${p.current} · cycle ${p.cycle}</p><p class="small muted">Edited ${escape(store.localUpdatedAt ? new Date(store.localUpdatedAt).toLocaleString() : 'not recorded')}<br>Based on revision ${store.revision}</p></section><section><h3>Saved online version</h3><p>${remote.history.length} workouts · session ${remote.current} · cycle ${remote.cycle}</p><p class="small muted">Saved ${escape(new Date(latest.updatedAt).toLocaleString())}<br>Revision ${latest.revision}</p></section></div><div class="settings-buttons"><button class="button primary" data-action="cloud-conflict-export">1. Export this device’s version</button><button class="button secondary" data-action="cloud-conflict-server-export">Export saved online version</button></div><p class="small muted">After downloading, confirm the backup is saved before continuing. Either choice replaces the entire account document, including drafts, notes and timers.</p><div class="dialog-actions"><button class="button secondary" data-action="cloud-conflict-server" ${conflictExported ? '' : 'disabled'}>2. Use saved online version</button><button class="button danger-outline" data-action="cloud-conflict-local" ${conflictExported ? '' : 'disabled'}>2. Keep this device’s version</button></div>`);
  } catch (e) { toast(e.message); }
}
function chooseCloudImport(imported) {
  const candidates = clone(imported.profiles);
  showDialog('#cloud-dialog', `<div class="dialog-heading"><h2 id="cloud-title">Import exactly one person</h2>${closeButton}</div><p class="dialog-copy">This backup contains ${candidates.length} profile${candidates.length === 1 ? '' : 's'}. Only the person you choose will replace @${escape(store.account.username)}’s account data. No other person will be uploaded. Keep the original backup safe.</p><form id="cloud-import-form"><label class="form-label">Choose your profile<select id="cloud-import-choice" required><option value="">Choose one person…</option>${candidates.map((p, i) => `<option value="${i}">${escape(p.name)} · ${p.history.length} workouts</option>`).join('')}</select></label><button class="button primary" type="submit">Review import</button><p class="small muted">This replaces, not merges. Your current account gets a local rollback first.</p></form>`);
  $('#cloud-import-form').addEventListener('submit', e => {
    e.preventDefault(); const selected = candidates[Number($('#cloud-import-choice').value)];
    if ($('#cloud-import-choice').value === '' || !selected) return;
    $('#cloud-dialog').close();
    confirmDialog('Replace this account with the selected profile?', `Import only ${selected.name} (${selected.history.length} workouts) into @${store.account.username}? All current account training data will be replaced after sync. Other profiles in the backup are excluded. A rollback of this account is saved on this device.`, 'Import this person only', () => {
      try {
        const next = clone(state); next.profiles = [{...selected, id: store.account.id}]; next.activeProfileId = store.account.id;
        store.replace(validateState(next), state); state = next; openExercises = new Set([0]); render(); void store.flush(); toast('Selected profile imported · check sync status. Other people were not uploaded.');
      } catch (error) { toast(error.message); }
    }, true);
  }, {once: true});
}
function exportExistingLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { toast('No local-only profiles at this address. Open the old tracker and export there.'); return; }
    download(JSON.parse(raw), filename('strength-tracker-ALL-LOCAL-USERS'));
    toast('Export contains ALL local users on this browser. Keep it private. Nothing uploaded.');
  } catch { toast('Local backup could not be read. Open the old local tracker to export recovery data.'); }
}
function handleCloudClick(button) {
  const action = button.dataset.action;
  if (!action.startsWith('cloud-')) return false;
  const run = async () => {
    if (action.startsWith('cloud-auth-')) { if (authBusy) return; authView = action.slice(11); renderAuth(); return; }
    if (action === 'cloud-local-export') { exportExistingLocal(); return; }
    if (action === 'cloud-pending-export') { exportAll(); return; }
    if (action === 'cloud-reload') { location.reload(); return; }
    if (action === 'cloud-recovery-download') { if (recoveryOnce) download({username: recoveryUsername, recoveryCode: recoveryOnce, warning: 'Keep private. This code can reset your account password.'}, filename('strength-tracker-PRIVATE-recovery-code')); return; }
    if (action === 'cloud-recovery-done') { recoveryOnce = null; recoveryUsername = ''; $('#cloud-dialog').close(); $('#cloud-dialog').innerHTML = ''; return; }
    if (!signedIn()) return;
    if (action === 'cloud-settings') { $('#profile-dialog').close(); location.hash = 'settings'; return; }
    if (action === 'cloud-retry') { if (store.dirty) await store.flush(); else await store.refresh(); return; }
    if (action === 'cloud-conflict') { conflictExported = false; await showCloudConflict(); return; }
    if (action === 'cloud-conflict-export') { exportAll(); conflictExported = true; await showCloudConflict(); return; }
    if (action === 'cloud-conflict-server-export') {
      const latest = store.conflict || await store.latestConflict();
      download({app: APP, version: 3, revision: latest.revision, activeProfileId: latest.account.id, theme: latest.theme, profiles: [latest.profile]}, filename('strength-tracker-server-version')); return;
    }
    if (['cloud-conflict-server', 'cloud-conflict-local'].includes(action)) {
      if (!conflictExported) return;
      const server = action.endsWith('server');
      confirmDialog(server ? 'Use the saved online version?' : 'Replace the online version with this device?', 'Confirm that your device-version export was saved somewhere safe. This replaces the entire selected version, including drafts. A further remote change will cause another conflict rather than being silently overwritten.', server ? 'Backup saved · use online version' : 'Backup saved · keep this device', async () => {
        try { $('#cloud-dialog').close(); await store.resolve(server ? 'server' : 'local'); render(); } catch (e) { toast(e.message); }
      }, !server); return;
    }
    if (action === 'cloud-logout') {
      if (store.dirty && !store.locked) await store.flush();
      const pending = store.dirty || store.locked || store.failed;
      confirmDialog('Sign out of this account?', pending ? 'Some work is not confirmed saved. Download the account backup now before signing out. Signing out clears this account’s device cache and rollback; pending changes will not upload afterwards.' : 'Your data saved online stays safe. This account’s device cache and rollback will be cleared. Other devices stay signed in.', pending ? 'Export backup & sign out' : 'Sign out', async () => {
        try {
          if (pending) exportAll();
          await store.logout(); state = emptyAccountState(); recoveryOnce = null; confirmAction = null;
          $$('dialog').forEach(d => { d.close(); d.innerHTML = ''; }); $('#storage-error').hidden = true; authView = 'login'; render();
        } catch (e) { toast(`Not signed out. ${e.message}`); }
      });
    }
  };
  void run().catch(e => toast(e.message)); return true;
}
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!isCloud || !['cloud-auth-form', 'cloud-name-form', 'cloud-password-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.id === 'cloud-name-form') {
    const name = new FormData(form).get('name').trim();
    if (!signedIn() || !name || name.length > 40) return;
    profile().name = name; persist(); render(); renderAccount(); return;
  }
  if (authBusy) return;
  authBusy = true; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  const originalLabel = submit.textContent; submit.textContent = form.id === 'cloud-password-form' ? 'Changing password…' : authView === 'signup' ? 'Creating account…' : authView === 'recover' ? 'Resetting password…' : 'Signing in…';
  form.setAttribute('aria-busy', 'true');
  const authLinks = $$('.auth-links button'); authLinks.forEach(button => { button.disabled = true; });
  const progress = form.querySelector('#auth-progress');
  const requestDelay = setTimeout(() => {
    if (progress) { progress.hidden = false; progress.textContent = 'Still waiting for a response. The service may be waking up. Keep this page open; if the request fails, you can try again.'; }
  }, 8000);
  const errorEl = form.querySelector('[role="alert"], [role="status"]'); if (errorEl) errorEl.textContent = '';
  try {
    const values = Object.fromEntries(new FormData(form));
    if (form.id === 'cloud-password-form') {
      if (!signedIn()) return;
      await api('/api/auth/password', {method: 'POST', body: JSON.stringify(values)}); form.reset(); toast('Password changed. Other devices must sign in again.'); return;
    }
    const result = await api(`/api/auth/${authView}`, {method: 'POST', body: JSON.stringify(values)});
    form.reset();
    if (authView === 'recover') { authView = 'login'; renderAuth(); window.scrollTo({top: 0, behavior: 'instant'}); showRecovery(result.recoveryCode, values.username); }
    else { await store.adopt(result); render(); window.scrollTo({top: 0, behavior: 'instant'}); if (result.recoveryCode) showRecovery(result.recoveryCode, values.username); }
  } catch (e) { if (errorEl) errorEl.textContent = e.message; else toast(e.message); }
  finally { clearTimeout(requestDelay); authBusy = false; form.removeAttribute('aria-busy'); submit.disabled = false; submit.textContent = originalLabel; authLinks.forEach(button => { button.disabled = false; }); if (progress) progress.hidden = true; }
});
$('#cloud-dialog').addEventListener('cancel', event => { if (recoveryOnce) event.preventDefault(); });
