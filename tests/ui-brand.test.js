import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {icon, brandMark} from '../icons.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const app = read('app.js'), html = read('index.html'), css = read('styles.css');
const visibleText = markup => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const authSource = app.slice(app.indexOf('function passwordField('), app.indexOf('function cloudAccountSettings('));
function renderAuth(authView, overrides = {}) {
  const elements = new Map();
  const $ = key => { if (!elements.has(key)) elements.set(key, {}); return elements.get(key); };
  runInNewContext(`${authSource}\nrenderAuth();`, {
    $, authView, mode: 'cloud', store: {}, updateModeChrome() {}, document: {}, APP: 'Strength Training Tracker',
    icon, brandMark, escape: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), ...overrides
  });
  return $('#main').innerHTML;
}
const input = (markup, id) => markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] || '';

test('static first paint has the complete brand, real skeleton and script-independent retry', () => {
  assert.match(html, /<title>Strength Training Tracker<\/title>/);
  assert.match(html, /<body class="is-loading">/);
  assert.match(html, /data-testid="tracker-loading"/);
  assert.match(html, /class="boot-skeleton" aria-hidden="true"/);
  assert.match(html, /<a href="" id="boot-retry"/);
  assert.doesNotMatch(visibleText(html), /\bcloud\b|Opening…|Opening tracker/i);
  assert.equal(JSON.parse(read('manifest.webmanifest')).name, 'Strength Training Tracker');
  assert.match(html, /On this device/);
  assert.match(html, /Use synced tracker/);
  assert.match(app, /ALL local users[\s\S]*explicitly choose exactly one profile[\s\S]*Nothing uploads from this local address/);
});

test('account landing uses one primary action, no storage-provider branding and no app navigation', () => {
  for (const mode of ['login', 'signup', 'recover']) {
    const markup = renderAuth(mode), text = visibleText(markup);
    assert.match(text, /Strength Training Tracker/);
    assert.doesNotMatch(text, /\bcloud\b|GitHub|Public display name|email sign.in/i);
    assert.equal((markup.match(/class="button primary"/g) || []).length, 1);
    assert.match(markup, /data-testid="auth-form"/);
    assert.match(markup, /data-testid="auth-submit"/);
    assert.doesNotMatch(markup, /<nav\b|class="sidebar"/);
  }
  assert.match(renderAuth('login'), /Welcome back/);
  assert.match(renderAuth('signup'), /Create your account/);
  assert.match(renderAuth('login'), /data-action="cloud-auth-signup">Create account/);
  assert.match(renderAuth('login'), /data-action="cloud-auth-recover">Forgot password/);
  assert.match(css, /:is\(\.is-loading, \.signed-out\) \.sidebar/);
  assert.match(css, /:is\(\.is-loading, \.signed-out\) \.topbar/);
});

test('registration retains required username, display name, invitation and strong password fields', () => {
  const signup = renderAuth('signup');
  for (const id of ['auth-username', 'auth-name', 'auth-invite', 'auth-password']) assert.match(input(signup, id), /\brequired\b/);
  assert.match(input(signup, 'auth-invite'), /minlength="12"/);
  assert.match(input(signup, 'auth-invite'), /name="inviteCode"/);
  assert.match(input(signup, 'auth-invite'), /aria-describedby="invite-hint"/);
  assert.match(signup, /Ask your host for an invitation code/);
  assert.match(input(signup, 'auth-password'), /minlength="12"/);
  assert.match(input(signup, 'auth-password'), /maxlength="128"/);
  assert.match(input(signup, 'auth-password'), /autocomplete="new-password"/);
  assert.match(input(renderAuth('login'), 'auth-password'), /autocomplete="current-password"/);
  assert.match(input(signup, 'auth-username'), /autocomplete="username"/);
  assert.doesNotMatch(signup, /type="email"/);
});

test('password visibility is an accessible, non-submit control that preserves input metadata and value', () => {
  const markup = renderAuth('login');
  assert.match(markup, /type="button" class="password-toggle"/);
  assert.match(markup, /data-testid="toggle-auth-password"/);
  assert.match(markup, /aria-controls="auth-password" aria-label="Show password" aria-pressed="false"/);
  const field = {type: 'password', value: 'unchanged password', autocomplete: 'current-password', minLength: 12, required: true};
  const attributes = {};
  const button = {dataset: {action: 'toggle-password', passwordFor: 'auth-password', passwordLabel: 'Password'}, setAttribute: (key, value) => { attributes[key] = value; }};
  const start = app.indexOf('document.addEventListener("click", event => {') + 'document.addEventListener("click", event => {'.length;
  const end = app.indexOf('  if (isCloud && handleCloudClick(button)) return;', start);
  const click = runInNewContext(`event => {${app.slice(start, end)}}`, {document: {getElementById: () => field}, icon});
  const event = {target: {closest: () => button}};
  click(event); assert.equal(field.type, 'text'); assert.equal(attributes['aria-pressed'], 'true'); assert.equal(attributes['aria-label'], 'Hide password');
  click(event); assert.equal(field.type, 'password'); assert.equal(attributes['aria-pressed'], 'false'); assert.equal(attributes['aria-label'], 'Show password');
  assert.equal(field.value, 'unchanged password'); assert.equal(field.autocomplete, 'current-password'); assert.equal(field.minLength, 12); assert.equal(field.required, true);
  assert.match(app, /id: 'account-current-password'/); assert.match(app, /id: 'account-new-password'/);
});

test('delayed and failed connections provide retry without changing detection or claiming saved work', () => {
  assert.match(app, /const bootDelay = setTimeout\([\s\S]*?8000\)/);
  assert.match(app, /clearTimeout\(bootDelay\)/);
  assert.match(read('cloud.js'), /AbortSignal.timeout\(12000\)/);
  assert.match(read('cloud.js'), /AbortSignal.timeout\(90000\)/);
  assert.match(css, /tracker-breathe 1\.8s ease-in-out 4/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.loading-delayed[^{]*\{ animation: none; \}/);
  const error = renderAuth('login', {mode: 'unavailable', store: {message: 'Connection unavailable. No data has been reset.'}});
  assert.match(error, /Retry connection/); assert.match(error, /No data has been reset/);
  const pending = renderAuth('login', {store: {sessionExpired: true, dirty: true}});
  assert.match(pending, /data-action="cloud-pending-export"/); assert.match(pending, /session has expired/);
});

test('recovery stays mandatory and storage details remain collapsed in Settings', () => {
  assert.match(renderAuth('recover'), /There is no email recovery/);
  assert.match(app, /This code is displayed once/);
  assert.match(app, /data-action="cloud-recovery-download"/);
  assert.match(app, /data-action="cloud-recovery-done">I have stored this code/);
  assert.match(app, /if \(recoveryOnce\) event.preventDefault\(\)/);
  assert.match(app, /<details class="storage-details"><summary>How your data is stored[\s\S]*?Private GitHub storage[\s\S]*?<\/details>/);
  assert.doesNotMatch(read('cloud.js'), /Saved to GitHub|['"`]Cloud\b/);
});
