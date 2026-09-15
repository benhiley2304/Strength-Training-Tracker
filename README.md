# Strength Training Tracker

A twelve-session training log with two deliberately separate modes. The existing static URL remains a fully working **local-only tracker** and migration source. A separate Node service enables **private, invite-only cloud accounts**, with progress stored in a private GitHub data repository. No Supabase, third-party auth SDK, external scripts or runtime npm dependencies.

## Cloud deployment — separate Render Node service

Do **not** convert or remove the existing static Render service. Deploy this same source repository as a **new Web Service**, Node runtime, **Free** instance. Use Node **20 or 22**, build command `npm install --omit=dev`, start command `npm start` (equivalent to `node server.js`). Render supplies `PORT`; the server binds `0.0.0.0`. `render.yaml` intentionally continues to describe only the existing static service, so following it cannot replace that service with Node. Place only the new tracker service in the tracker project/environment; if the connector cannot specify project placement, do that manually in the Render dashboard. Do not change any unrelated project.

The separate **private** data repository must already have an initialized `main` branch (a README is sufficient). Give a dedicated SSH **write deploy key** access to this data repository only. Never use a broad personal GitHub token in the app. The app source repository and static deployment must never contain private keys, account files, invite codes or session secrets.

### Environment contract

Set secrets directly in the new Render service's protected environment, not in code or `cloud-config.js`:

| Variable | Required value / meaning |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Exact HTTPS cloud service origin, e.g. `https://YOUR-CLOUD-SERVICE.onrender.com`; **no trailing slash**. Unsafe requests from other or missing Origins are rejected. |
| `SESSION_SECRET` | Cryptographically random secret, at least 32 bytes; 32 random bytes encoded as 64 hex characters is recommended. Keep stable across redeploys. Rotating it signs everyone out. |
| `INVITE_CODE` | Private invite string, at least 12 characters; use a long random value. Share only with intended users. Rotating it blocks old invites without affecting existing accounts. |
| `DATA_REPO_SSH` | `git@github.com:benhiley2304/Strength-Training-Tracker-Data.git` |
| `GITHUB_DEPLOY_KEY_BASE64` | Base64-encoded private SSH deploy key, authorized to **write the private data repository only**. |
| `GITHUB_KNOWN_HOSTS_BASE64` | Base64-encoded `known_hosts` content containing pinned official `github.com` SSH host keys. Provision from GitHub's authenticated/HTTPS metadata, not an unverified runtime key scan. SSH uses strict checking and fails closed. |
| `DATA_REPO_BRANCH` | Optional; defaults to `main`. Only a simple branch name is accepted. |
| `PORT` | Provided by Render; defaults to `3000` locally. |
| `TRUST_PROXY` | Optional; set `true` only behind trusted ingress that appends/overwrites the actual client IP. Uses the rightmost `X-Forwarded-For` entry for per-IP rate limits. Leave false when directly exposed. |

**Never** enable `STT_TEST_STORAGE` in production. The disk adapter requires `NODE_ENV=test` or the explicit local flag `STT_TEST_STORAGE=true`; it refuses `NODE_ENV=production` even if the flag is present. `STT_TEST_DIR` selects an isolated test directory (default `/tmp/stt-test-data`). These flags are for automated/local testing only, not an alternate production backend. Production does not fall back to disk when GitHub is unavailable.

The production checkout is `/tmp/stt-data`; key material is written with restrictive permissions under `/tmp/stt-ssh`. Both are ephemeral working files. Every account read/write is protected by one process-wide asynchronous transaction lock and refreshes the branch from GitHub first. A write uses an atomic file replacement, commit and normal push — **never a force-push**. Failed pushes retry at most three times, refreshing and rerunning uniqueness/revision checks; a remote conflict returns `409`. A save is acknowledged only after the remote push succeeds. A network failure after GitHub accepted a push can still produce an uncertain/error response: retry safely: authenticated equal-payload PUTs return the existing remote revision without another commit, including stale If-Match retries. The Git adapter still refreshes from the remote before this equality check.

### Publish the migration launch address

After the cloud service is healthy, set the public `CLOUD_URL` export in `cloud-config.js` to its HTTPS address. This file contains **only a public URL**, no credentials. Redeploy the existing static site with this change. Bump the service-worker `VERSION` whenever changing any shell asset or the launch URL.

The local tracker then shows **Move to cloud accounts** on desktop and mobile. It explains that its download includes **all local users**, downloads a backup, and opens the cloud address. It never uploads anything. Keep that all-profiles file private. The old address and its local storage remain usable.

On the cloud service:

1. Create an account with a username, password, display name and invite code. Save the one-time recovery code in a password manager. **No email is collected or verified.**
2. Settings → **Import a backup** → choose the export → explicitly choose **exactly one profile** from it. The selector starts empty, even for a one-profile backup.
3. Confirm which person's data will replace this account. A local rollback is saved first. The selected profile is assigned to the signed-in account; no other profile from the file is uploaded. Imports replace rather than merge.
4. Wait until **Saved to GitHub** is visible. Sign in to the same cloud address with the **same username and password** on the other device. The initial view pulls the server document first.

An all-profiles file from another web address cannot be read automatically because browser storage is origin-specific. Uploading it is always explicit. The cloud profile menu contains only the signed-in account, editable display name, password/settings controls and logout — never a list of other users.

## Cloud security and sync behavior

- Usernames are normalized, case-insensitive, 3–32 ASCII letters/numbers/underscores/hyphens and must start with a letter/number. Display names can be changed; usernames identify the account. Passwords are 12–128 characters (maximum 512 UTF-8 bytes), salted with 24 random bytes and hashed using asynchronous Node `scrypt` (`N=32768`, `r=8`, `p=1`, 64-byte result). Passwords are never stored as plaintext.
- Each account has one JSON document at `accounts/<SHA256(normalized-username)>.json`, containing hashed credentials, session version, one profile, theme, document revision and timestamps. API responses omit password/recovery hashes and session internals. Paths and account access come exclusively from authenticated identity, never an input pathname/account selector.
- Sessions are signed with HMAC-SHA256, expire after 30 days, and use a host-only `__Host-stt_session` cookie with `HttpOnly; Secure; SameSite=Lax; Path=/`. No tokens are stored in JavaScript storage. Password changes/recovery increment the server-side session version, invalidating older sessions; logout revokes just the current session. Recovery codes are random 192-bit bearer secrets, stored only as SHA-256 hashes and rotated on reset. A reset displays the new code once.
- Auth endpoints use bounded per-IP/per-username rate limiting. Credential/account-not-found failures are deliberately generic. Unsafe API methods require the exact configured Origin, cross-site fetches are refused, and no CORS access is offered. Input types, sizes, revisions, ranges and programme structure are checked. Request bodies, credentials and git errors are never logged. Auth/account responses and cloud account HTML use `Cache-Control: no-store`; the server serves only an explicit static-asset allowlist.
- Edits and their acknowledged `baseState` are cached under the signed-in account ID and debounced for about 1.5 seconds. No-op inputs (including render-created empty drafts) do not create writes. The normal status is “Saving your latest changes…”, “Reconnecting…” or “All changes saved”. Only a validated remote acknowledgement, or an authenticated read of an equal payload, confirms an online save. Local snapshot failure remains visible even if online saving succeeds.
- Updates include `If-Match`/revision. A `409` returns **only that account's latest document**. The client applies its actual field-level delta from the acknowledged baseline, preserves independent remote fields and merges history by stable workout ID, then retries at most three PUTs per flush. Client clocks never select an entire winning document. Equal stale caches clear without a PUT; equal authenticated server PUTs are read-only even with an old revision.
- Routine resume, same-revision pending caches and tab changes reconcile automatically. Removed/finished draft IDs cannot be resurrected; a separate post-finish effort needs a new ID and a later start. Unsupported simultaneous unfinished sessions, corrupt snapshots and destructive/import conflicts still require review. Explicit imports retain a replacement marker and rollback: they replace rather than union history, and require renewed confirmation if the remote changed.
- V1 dirty caches without a baseline use a conservative migration: pending local settings are preferred and empty local values/drafts cannot erase nonempty remote work. Same-revision replay and demonstrably post-acknowledgement additions retain both histories; unmatched older history/meaningful drafts require review because they may have been intentionally removed online. Profile-default bodyweight changes never manufacture draft effort; explicit workout-only bodyweight edits are marked separately. This is best-effort because V1 did not record which fields changed. Before reconciliation, both full account snapshots are archived in a rolling five-entry, account-scoped device recovery journal. Journaling failure pauses reconciliation instead of destroying the other version. Recovery can be exported from Settings when review is needed.
- Focus, visibility and online events flush pending work (rather than refusing dirty refreshes). There is no periodic network polling/keep-alive. Transient reads/writes have bounded exponential retries, paused while hidden/offline. In-flight stale generations and older remote revisions cannot replace newer state. Real `401` responses require sign-in and retain pending work for export.
- An **already-open signed-in tab** remains editable offline. Reopening still validates the server session before displaying any cached account. The service worker caches the public, account-free index/brand shell plus allowlisted JS/CSS/fonts/icons without credentials, so a returning PWA shows the shell immediately while the service wakes. It never intercepts or caches `/api/`, auth responses, account payloads, cookies or tokens.
- Caches, import rollbacks and recovery journals are **not encrypted** and belong only on trusted devices. Logout clears the active account's memory/cache/rollback/journal, never another account. Export pending work before logout; exported files are outside app cleanup. Cleanup failures warn users to clear site data. Use a private browsing session on shared devices.

### Operational limits and recovery

This is a small, invite-only tracker, **not a high-volume database**. GitHub commits and whole-document sync are suitable for this deliberately small use case, but do not provide database-grade throughput, transactions across multiple account files, guaranteed availability or fully general conflict-free collaboration. Automatic merging covers the tracker’s supported field/history/draft semantics; ambiguous destructive operations still require review. The app operator and anyone with repository access can read training data and credential hashes; this is not end-to-end encryption. Old values remain in private Git history. Keep repository access restricted, retain independent exports, and never make the data repository public.

The Render Free service can sleep when idle and take around a minute to wake. Network and GitHub delays can be longer; pending work is not confirmed saved until the UI says so. There are no guaranteed background writes or timer notifications. Keep the tab open or export if sync fails. A redeploy loses the disposable checkout, **not the data already pushed to GitHub**. Protect the deploy key and secrets; rotate/revoke compromised credentials. Restore repository backups carefully: restoring older account files can restore old password/session state, so rotate `SESSION_SECRET` after an operator-level rollback.

Health/config check: `GET /api/config` returns JSON with `cloud: true` without requiring sign-in. Static hosts return a non-JSON 404/rewrite and stay local. A previously detected cloud host skips this redundant probe and never silently downgrades during an outage. Unknown hosts retry transient startup errors up to three times with 90-second request bounds and exponential delays; confirmed static 404/HTML fallbacks stay local. There is no background keep-alive polling while signed out.

### Cloud code and tests

| File | Purpose |
| --- | --- |
| `server.js` | Dependency-free HTTP server, strict asset allowlist, Origin checks, API validation and account routes |
| `server/auth.js` | Async scrypt, constant-time checks, HMAC sessions, recovery and bounded rate limits |
| `server/storage.js` | Serialized Git transactions, atomic files, remote acknowledgement and test-only disk adapter |
| `cloud.js` | Mode detection, baseline cache, rolling recovery journal, bounded reconnect sync and explicit destructive review |
| `sync-merge.js` | Dependency-free semantic equality and baseline-aware field/history/draft reconciliation |
| `cloud-config.js` | Public, optional launch URL from the old local site |
| `tests/cloud-server.test.js` | Auth privacy, CSRF, recovery, malformed inputs, revisions, failure and persistence |
| `tests/cloud-client.test.js` | Offline/cache resilience, sync races, conflicts, explicit import constraints and isolation |
| `tests/reconnect-sync.test.js` | Synthetic legacy/baseline reconciliation, drafts/history, imports, tab races, lifecycle, retry and recovery cases |
| `tests/shell-sync.test.js` | Public-shell offline boot and service-worker API/auth exclusion |
| `tests/git-storage.test.js` | Real Git transactions against isolated local bare test repositories; acknowledgement, retries and concurrent commits |

Run `npm run check && npm test`. Tests need Node 20/22 and Git, no production credentials or network services. The original 23 programme/model/local-storage regression tests remain included. Real GitHub/Render and two independent browser-context checks are deployment acceptance checks, not simulated by the unit suite.

## Local-only mode reference

The remainder documents the preserved static tracker. Statements below about no cloud or device-only profiles apply **only to the existing static/local mode**, not to the separate authenticated Node service.

A static, local-first PWA for a twelve-session strength programme. Click **Ben Hiley** in the header to switch to Toby or Will, or add and rename a local profile. No account, authentication service, API, database server or cloud sync is involved.

## Local-only run and deploy

Serve this directory with any static HTTP server. For example:

```sh
npx serve .
```

There is no build step or runtime dependency. ES modules need HTTP(S), not a `file://` URL. HTTPS (or localhost) is required for service workers. The existing `render.yaml`, manifest and SVG icons remain in place; Render can publish this repository as a static site.

The UI uses a locally bundled Manrope variable font. Its SIL Open Font License is in `FONT-LICENSE.txt`. No third-party CDN is needed, including for typography or charts.

```sh
npm run check
npm test
```

These commands use Node's built-in syntax checker and test runner; no installation is required.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic shell, navigation and native accessible dialogs |
| `styles.css` | Mobile-first set entry, desktop sidebar, light/dark themes and reduced-motion support |
| `programme.js` | Immutable exercise prescriptions and the twelve-session sequence |
| `model.js` | Data factories, validation, migrations, completion rules, estimates and guarded storage |
| `app.js` | Rendering, delegated input handling, profile management, timers, exports/imports and PWA update UI |
| `sw.js` | Versioned, allowlisted, same-origin app-shell cache |
| `tests/model.test.js` | Regression tests for the programme, migration, data integrity and storage failures |
| `pro.js`, `pro.css` | Historical V4 reference only; not loaded or cached by the new app |

The previous `pro.js` monkeypatch is disabled. There is one application state and one persistence path. The current programme is **exactly** the programme in `app.js` at commit `4916e7d`, including all twelve names, order, categories, set counts, repetitions and compound/bodyweight flags. A regression test compares the entire generated session array to that committed file.

## Local profiles and privacy

- Ben Hiley, Toby and Will are starter profiles. Only Ben receives existing legacy data.
- Every profile has separate history, current session, cycle state, drafts, bodyweight, rest preferences, notes, readiness and timers.
- New profiles have no invented workouts, bodyweight or readiness values.
- The active profile and appearance persist on this browser origin.
- Profiles organise data; **they are not security boundaries or sign-ins**. Anyone using this browser can open all profiles and export their data.
- Nothing syncs between browsers, installations, devices or origins. A preview URL will not contain data from the Render URL. Restore an exported backup to move data.
- Clearing browser data can remove everything. Export JSON regularly.

## Data model, version 3

Primary localStorage key: `strengthTrainingTrackerProfilesV3`.

```text
state
  app, version: 3, revision, activeProfileId, theme
  profiles[]
    id, name, bw (number or null)
    current (1–12), cycle, completed[] (logged sessions this cycle)
    restSeconds (0 disables automatic rest)
    drafts[sessionNumber]
      id (stable workout identity), session, cycle
      startedAt (epoch milliseconds or null)
      bwSnapshot (number or null)
      readiness {energy, sleep, joints} (each 1–5 or null)
      notes, conditioning
      restEndAt (epoch milliseconds or null)
      exercises[] {name, sets[] {kg, reps, rpe, done}}
    history[]
      id, date (ISO), session, cycle, name
      startedAt, durationSeconds (number or null)
      bwSnapshot, readiness, notes, conditioning, partial
      sets[] {exercise, set, kg, reps, rpe, done, compound, body, mobility?}
      legacy? (old records whose completion was never recorded)
    legacy {sources, warnings} or null
```

Draft numbers remain strings so an empty input is not confused with zero. Historical loads and reps are numbers. Bodyweight is captured when a draft is created and can be explicitly edited for that workout; updating a profile's default never rewrites existing snapshots. Starting the timer does not overwrite an explicitly entered workout snapshot.

### Completion and cycles

- Enter **explicit** load (0–1,500 kg), whole reps (1–200), and optionally RPE (1–10, half steps).
- Reps shown as placeholders are prescriptions, not logged values.
- A tick validates the set. Completed rows are read-only until unticked.
- An untick does not restart or extend rest.
- Added sets can be removed after confirmation. Prescribed sets can be cleared after confirmation, not silently removed from the planned total.
- Spinal Decompression is an activity: the prescription is `1 × —`, so it needs a completion tick, not invented reps or weight. Its volume is zero.
- Finish requires at least one completed valid set and a confirmation. Partial completion explicitly explains that unfinished rows in that draft will be discarded.
- A stable draft ID and confirmation guard prevent duplicate finishes. Only ticked, valid sets enter new history.
- Every finished record owns its readiness, notes, conditioning, duration and bodyweight snapshot. A fresh workout's readiness starts empty.
- Navigation wraps both directions without changing the cycle. Finishing session 12 starts the next cycle and clears its logged-session tally. Other uncompleted drafts are retained and keep their original cycle identity.
- The programme tally means **logged sessions**, including partials, not a claim that every prescribed set was completed.
- Starting a new cycle manually explicitly confirms clearing all of that profile's unfinished drafts and timers. History and other profiles stay intact.

## Non-destructive legacy migration

Migration reads, but **never removes or modifies**, these keys:

1. `strengthTrainingTrackerV2`
2. `strengthTrainingTrackerProV1`
3. `cycleLogV1`

The migration is performed only when the new profiles key does not exist. A valid new key is the source of truth on subsequent loads, so migration is idempotent.

### What is recovered

- V2 is preferred for current position, bodyweight, notes, conditioning and safely identified drafts. If it is absent/invalid, the original cycle log is used for safely interpretable profile settings and history.
- Both historical sources contribute history. An identical copied record (ID, date, session and sets) is not duplicated; distinct sets remain distinct records.
- Original `cycleLogV1.done` is an object such as `{"1": true}`, not an array. Truthy valid session keys are recovered.
- The raw JSON from every legacy source is archived inside Ben's profile as well as being left in its original key. Invalid records remain recoverable from that archive rather than being silently destroyed.
- All original history is marked **legacy / completion not recorded**. Both previous implementations saved filled rows without preserving the tick state, so this upgrade cannot truthfully infer which sets were completed. Their recorded tonnage is labelled as such; they do not qualify for verified e1RM.
- Historical duration, readiness and bodyweight snapshots were not stored. They remain “not recorded”; today's profile bodyweight is never applied retroactively.
- A pro workout start timestamp is attached only to a matching active V2 session with actual set activity. Pro readiness is attached only when its own timestamp is at/after that session start; stale readiness is archived, not recycled.
- V4 rest countdowns existed only in memory and cannot be recovered.

### Why original index-based drafts are archived

The actual original source (`git show 910b9fc:index.html`) uses a substantially different programme and exercise ordering. Assigning `cycleLogV1.draft["1-3"]` to exercise index 3 of today's programme would put load/reps against the wrong exercise.

Therefore original cycle drafts, original notes and conditioning choices are retained intact in the downloadable **legacy archive**, not blindly mapped into today's workout. The same conservative rule applies if V2 drafts are an exact copy of the original drafts (the old pro migration could make such a copy). The Settings screen explains this limitation. V2-native drafts retain their current-programme mapping.

## Import, export and rollback

- **Export all profiles** includes the entire version 3 state: all profiles, drafts, history, readiness, legacy archives and timer timestamps.
- Version 3 restore replaces the whole app after an explicit confirmation listing profile counts.
- Original single-user JSON exports restore into the currently selected profile after confirmation, preserving its name/ID and all other profiles.
- A combined legacy archive with the original storage-key names can also be restored as one profile.
- Imports are parsed and validated before any state changes. Unsupported versions, invalid active IDs, duplicate profile/workout IDs, malformed exercises, out-of-range values, invalid timestamps, invalid completed sets and oversized structures are rejected with visible feedback.
- File limit: 20 MB; up to 50 profiles, 20,000 history records/profile, 100 rows/exercise. Larger archives are rejected, never truncated by an import.
- Before replacement, the application must successfully write `strengthTrainingTrackerProfilesV3:rollback`, containing the current state and the original pre-restore raw primary-key bytes. If this fails (including quota), replacement is cancelled.
- **Download last rollback backup** downloads a directly importable profiles state and includes the previous raw data under `rollbackRecovery`, including unreadable bytes from a corrupt original key.
- Only the most recent rollback is kept. Export a rollback before another restore if you need multiple recovery points.
- A corrupt existing primary key is not overwritten by new defaults. The app enters a visible recovery/paused-save state and offers a recovery export.
- Another tab changing the primary key pauses saves instead of overwriting its changes. Export current in-memory work and reload to resolve the conflict.
- All storage access is caught. Blocked iframe/private storage or quota failure shows a persistent warning. The app stays usable in memory, but cannot promise reload persistence. Export before leaving. A restore will not proceed without a durable rollback.

## Timers

Elapsed duration derives from `Date.now() - startedAt`. Rest derives from `restEndAt - Date.now()`. No countdown counter is used as the source of truth. Timestamps survive reload, backgrounding and profile/session switches; the display catches up on return.

The rest dock belongs to the selected profile and selected session. Other timers keep running invisibly. Completing a non-mobility set starts the profile's configured rest. Unticking does not change the deadline. **+30s** adds to the remaining time, or starts 30 seconds if already expired. Cancel clears it.

Timers measure wall-clock elapsed time, including background/inactive time. There is no pause tracking, and changing the device clock can affect elapsed time. The app does not promise system notifications or audio while backgrounded.

## Honest analytics

- All counters and charts are derived from stored workouts, with explicit empty states.
- Four-week workload uses local-calendar Monday week boundaries. Bar values and a native HTML table provide a labelled chart and an accessible textual equivalent.
- Tonnage is **external load × reps as entered**, excluding bodyweight. It includes valid recorded legacy rows and is explicitly not a measure of effort. Consistent dumbbell entry matters; use combined DB load if comparing workload.
- e1RM uses Epley for 2–10 reps: `load × (1 + reps/30)`. For 1 rep, actual load is used.
- Only actually ticked, valid, known compound sets from the new schema are eligible. Legacy rows, accessory movements and >10 reps are excluded.
- Pull-ups calculate total-system estimate using that workout's BW snapshot, then subtract the snapshot to display **estimated added-load capacity**. No snapshot means no estimate.
- The mixed “Weighted Dip / Flat DB Press” prescription is excluded from e1RM because the actual movement cannot safely be inferred. Users can specify the choice in notes.
- Estimates are approximate, not measured PRs, targets or guarantees.
- History details show all stored sets, notes, conditioning, readiness, duration and bodyweight; missing old metadata remains visibly missing.

## Offline release strategy

`sw.js` caches only an explicit list of known, same-origin GET assets. It does not cache arbitrary network responses or return HTML for failed scripts/images/unknown requests. `cache.addAll` installs a whole release atomically. Failed assets prevent that release from installing.

A new worker waits instead of immediately replacing the active worker. The update banner explicitly activates the complete release after persisting pending data and a full device recovery journal; it does not require a network acknowledgement or routine conflict resolution first. Each cloud tab journals again before a controller-change reload so intervening edits are protected. Corrupt raw cache bytes are retained in recovery. If durable recovery cannot be written, activation/reload is refused and export is requested. Already-loaded pre-fix scripts cannot gain this behavior retrospectively: close every tracker tab/PWA window and reopen once the new worker has installed; do not clear site data. The old dirty V1 cache is then automatically reconciled by the new code. Only this app's old cache prefix is cleaned up, not unrelated caches.

**Bump the VERSION string whenever any shell asset changes.** Add every runtime asset to the allowlist. Do not add CDN requests or blanket navigation fallbacks.

The first online visit prepares the cache; a subsequent controlled load is needed for fully offline operation. Sandboxed previews may block service workers even when the app itself is usable.

## QA

Reconnect release acceptance: see `RECONNECT_QA.txt`.

### Automated regression suite

`npm test` covers:

1. Exact preservation of every original V2 session prescription.
2. Session navigation wrap.
3. Profile/draft isolation and empty defaults.
4. Load/reps/RPE completion validation.
5. Completed-only history and explicit mobility activity.
6. Compound e1RM limits, single reps, missing BW and weighted pull-up snapshots.
7. V2/pro migration without fabricated metadata.
8. Stale readiness exclusion.
9. Object-shaped original cycle ticks and archived incompatible drafts.
10. Copied history deduplication and unsafe copied-draft protection.
11. Malformed legacy data retained in the archive.
12. Full export/import round trip with running timestamps.
13. Invalid/unsupported import rejection.
14. Legacy individual restore detection.
15. Idempotent migration and original-key preservation.
16. Blocked storage handling.
17. Corrupt-primary-key protection.
18. Durable rollback-before-replacement.
19. Quota failure aborting replacement.
20. Cross-tab write protection.
21. Month-boundary workload attribution without duplicate counting.
22. Non-overlapping year-boundary workload and future-record exclusion.
23. Local-midnight week boundaries across daylight-saving transitions.

### Functional browser selectors

| Workflow | Stable selector / expected result |
| --- | --- |
| Profile picker | `#profile-button` → `#profile-dialog`; initial names Ben Hiley/Toby/Will |
| Switch | `[data-action="switch-profile"][data-id="toby"]`; independent blank draft/history |
| Add / rename | `#profile-form`, `#profile-name-input`, `[data-action="rename-profile"]` |
| Navigation | `[data-view="train"]`, `programme`, `progress`, `settings` |
| Session wrap | `[data-action="previous"]` / `next`; 1 → 12 → 1 |
| Accordion | `[data-action="accordion"][data-index="0"]`; updates `aria-expanded` |
| Set inputs | `[data-testid="set-0-0-kg"]`, `set-0-0-reps`, `set-0-0-rpe` |
| Completion | `[data-testid="complete-0-0"]`; invalid input reveals `.set-error` |
| Rest | `#rest-clock`, `[data-action="add-rest"]`, `[data-action="cancel-rest"]` |
| Readiness / BW | `[data-readiness="energy"]`, `sleep`, `joints`, `#workout-bw` |
| Notes | `#workout-notes`, `#conditioning` |
| Finish | `#finish-workout` → `#confirm-dialog` → `#confirm-accept` |
| Details | `[data-action="history"]` → `#detail-dialog` |
| Export / import | `[data-action="export"]`, `#import-file`, `#import-status` |
| Cycle / delete | `[data-action="reset-cycle"]`, `[data-action="delete-profile"]`; confirmation required |
| Appearance | `#appearance` or `#theme-toggle` on desktop |

### Browser acceptance checklist

- Complete one set, untick it, verify no rest restart, retick, switch profiles, reload and return; verify draft and absolute timer timestamps survive.
- Complete only one set, fill another without ticking, finish partially, verify only the ticked set in details. Rapid confirmation clicks must not duplicate history.
- Add notes/readiness/BW, finish, revisit the session and ensure the next draft's readiness is empty; old details remain unchanged.
- Export all, alter profiles, import with cancel and accept paths, download rollback and restore it. Test invalid JSON, wrong schema and quota failure.
- Verify empty Toby/Will and new profiles have no inherited history, BW or readiness.
- Rename/add duplicates and empty names should give clear errors. Deletion requires confirmation and the last remaining profile cannot be deleted.
- Exercise programme disclosure, navigation 12/1 wrap, all set fields (including RPE), dark appearance, details dialogs and visible focus on keyboard.
- Test 320/375/390 px phones, tablet, desktop and 200% zoom. No horizontal page scrolling; check expanded exercises and long profile names.
- Use a clean service-worker-enabled context: load online twice, go offline, reload, log/finish a workout, then reconnect. Confirm all known assets are served locally.
- Test blocked `localStorage` and cross-tab change events. UI must render with a persistent warning and usable exports.
- Check native dialog focus containment, Escape/cancel and focus restoration; history chart data must be available without relying on bar heights.

During implementation, the unit suite passed and a Chromium interaction pass exercised invalid completion, valid set entry, rest untick behaviour, profile isolation, partial save, history details, reload persistence and both-direction navigation. Light/dark mobile and desktop screenshots were also captured outside this repository for review. The parent release workflow performs final deployment/browser acceptance; production device-specific PWA installation and background behaviour still merit physical iOS/Android testing.
