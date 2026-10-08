'use strict';

/*
 * Muse Control — vanilla, CSP-friendly client (no inline code, no external requests).
 * Every user- or Discord-provided value is rendered with textContent.
 * The page language comes from <html lang> (the server renders /it/... and /en/...);
 * the copy is loaded from /assets/i18n/<lang>.json.
 */

const LOCALES = ['it', 'en'];
const LOCALE = document.documentElement.lang === 'it' ? 'it' : 'en';
const INTL_LOCALE = LOCALE === 'it' ? 'it-IT' : 'en-GB';
const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_CDN = 'https://cdn.discordapp.com/';

let STRINGS = {};

const loadStrings = async () => {
  try {
    const response = await fetch(`/assets/i18n/${LOCALE}.json`, {credentials: 'same-origin'});
    if (response.ok) {
      const body = await response.json();
      if (body && typeof body === 'object') STRINGS = body;
    }
  } catch {
    STRINGS = {};
  }
};

const lookup = key => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), STRINGS);

const t = (key, params = {}) => {
  const value = lookup(key);
  if (typeof value !== 'string') {
    return key;
  }

  return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};

/** Same fields and limits as the worker whitelist; `locale` is the bot language. */
const SETTINGS = [
  {key: 'locale', type: 'select', options: ['en', 'it']},
  {key: 'defaultVolume', type: 'number', min: 0, max: 100},
  {key: 'playlistLimit', type: 'number', min: 1, max: 500},
  {key: 'secondsToWaitAfterQueueEmpties', type: 'number', min: 0, max: 86400},
  {key: 'defaultQueuePageSize', type: 'number', min: 1, max: 30},
  {key: 'leaveIfNoListeners', type: 'boolean'},
  {key: 'queueAddResponseEphemeral', type: 'boolean'},
  {key: 'autoAnnounceNextSong', type: 'boolean'},
  {key: 'turnDownVolumeWhenPeopleSpeak', type: 'boolean'},
  {key: 'turnDownVolumeWhenPeopleSpeakTarget', type: 'number', min: 0, max: 100},
];

const settingLabel = definition => t(`settings.fields.${definition.key}.label`);
const settingHint = definition => t(`settings.fields.${definition.key}.hint`);

/* ---------- DOM helpers ---------- */

const $ = id => document.getElementById(id);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const button = (label, className, onClick) => {
  const node = el('button', `button ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  arrowRight: 'M9 5l7 7-7 7',
  plus: 'M12 5v14M5 12h14',
};

const icon = (name, size = 18) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
};

const isDiscordCdn = url => typeof url === 'string' && url.startsWith(DISCORD_CDN);

/** Image from the Discord CDN, or a lettered placeholder (CSP only allows that image origin). */
const picture = (url, name, placeholderClass = 'guild-placeholder', imageClass = '') => {
  if (isDiscordCdn(url)) {
    const image = el('img', imageClass);
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    return image;
  }

  return el('div', placeholderClass, String(name || '?').trim().slice(0, 1) || '?');
};

const identity = (url, name, detail, options = {}) => {
  const wrapper = el('div', 'identity');
  const copy = el('div');
  copy.append(el('strong', '', name));
  if (detail !== undefined) copy.append(el('span', 'mono', detail));
  wrapper.append(picture(url, name, options.round ? 'avatar-fallback' : 'guild-placeholder', options.round ? 'round' : ''), copy);
  return wrapper;
};

const tag = (text, variant) => el('span', variant ? `tag tag-${variant}` : 'tag', text);
const state = (text, variant) => el('span', variant ? `state state-${variant}` : 'state', text);

const applyTranslations = () => {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }

  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  }

  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  }
};

let toastTimer = null;
const toast = (message, isError = false) => {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 4200);
};

const showNotice = (node, message) => {
  node.textContent = message || '';
  node.hidden = !message;
};

const setMessage = (node, message, kind) => {
  node.textContent = message || '';
  node.className = `form-message ${kind || 'muted'}`;
};

const formatNumber = value => new Intl.NumberFormat(INTL_LOCALE).format(Number(value) || 0);

const formatDate = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(INTL_LOCALE, {dateStyle: 'short', timeStyle: 'medium'}).format(date);
};

const formatUptime = seconds => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return t('super.uptimeDays', {days, hours});
  if (hours > 0) return t('super.uptimeHours', {hours, minutes});
  return t('super.uptimeMinutes', {minutes});
};

/* ---------- API ---------- */

let session = null;

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const api = async (url, options = {}) => {
  const response = await fetch(url, {credentials: 'same-origin', ...options});
  const body = await response.json().catch(() => ({}));

  if (response.status === 401) {
    session = null;
    throw new ApiError('AUTH_REQUIRED', 401, body.code);
  }

  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : t('errors.generic'), response.status, body.code);
  }

  return body;
};

const mutation = (method, body) => ({
  method,
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': session ? session.csrfToken : '',
  },
  ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});

/** Browser-facing message for an API failure; orchestrator 4xx messages are shown as-is. */
const errorMessage = error => {
  if (!(error instanceof ApiError)) return t('errors.generic');
  if (error.status === 403) return error.code === 'SUPER_ADMIN_REQUIRED' ? t('super.denied') : t('errors.forbidden');
  if (error.status === 429) return t('errors.rateLimited');
  if (error.status >= 500) return t('errors.unavailable');
  return error.message;
};

/** Shared handler: a 401 sends the user back to the login view. */
const handleFailure = (error, report) => {
  if (error instanceof ApiError && error.status === 401) {
    render();
    return;
  }

  report(errorMessage(error));
};

/* ---------- Routing ---------- */

/** Every view lives under the language prefix: /it/dashboard, /en/server/:id, ... */
const BASE = `/${LOCALE}`;
const DASHBOARD_PATH = `${BASE}/dashboard`;
const SUPER_PATH = `${BASE}/super`;
const NEW_SERVER_ANCHOR = 'nuovo-server';
const LANGUAGE_PREFIX = /^\/(?:it|en)(?=\/|$)/;

const currentRoute = () => {
  const path = window.location.pathname;
  if (path === DASHBOARD_PATH) return {view: 'home'};
  if (path === SUPER_PATH) return {view: 'super'};
  const match = /^\/(?:it|en)\/server\/(\d{17,20})$/.exec(path);
  if (match) return {view: 'guild', guildId: match[1]};
  return {view: 'home'};
};

/** Points the IT/EN switcher links at the current view in the other language. */
const updateLanguageLinks = () => {
  const rest = window.location.pathname.replace(LANGUAGE_PREFIX, '');
  for (const link of document.querySelectorAll('a[data-lang-link]')) {
    const target = link.dataset.langLink;
    if (LOCALES.includes(target)) link.setAttribute('href', `/${target}${rest}`);
  }
};

const navigate = path => {
  if (path !== window.location.pathname) {
    window.history.pushState(null, '', path);
  }

  for (const menu of document.querySelectorAll('.site-mobile-menu[open]')) {
    menu.open = false;
  }

  window.scrollTo(0, 0);
  render();
};

const showSection = id => {
  for (const view of ['view-loading', 'view-login', 'view-home', 'view-super']) {
    $(view).hidden = view !== id;
  }
};

const updateChrome = route => {
  const signedIn = session !== null;
  for (const node of document.querySelectorAll('[data-auth="anonymous"]')) node.hidden = signedIn;
  for (const node of document.querySelectorAll('[data-auth="user"]')) node.hidden = !signedIn;
  for (const node of document.querySelectorAll('[data-super-only]')) node.hidden = !(session && session.superAdmin);
  for (const node of document.querySelectorAll('[data-route-link]')) {
    node.classList.toggle('is-active', signedIn && node.dataset.routeLink === route.view);
  }
};

const render = () => {
  const route = currentRoute();
  updateChrome(route);
  updateLanguageLinks();

  if (!session) {
    document.title = t('title.home');
    $('guild-view').hidden = true;
    $('site-view').hidden = false;
    showSection('view-login');
    return;
  }

  if (route.view === 'guild') {
    $('site-view').hidden = true;
    $('guild-view').hidden = false;
    void openGuild(route.guildId);
    return;
  }

  selectedGuildId = null;
  $('guild-view').hidden = true;
  $('site-view').hidden = false;

  if (route.view === 'super') {
    document.title = t('title.super');
    showSection('view-super');
    void loadOverview();
    return;
  }

  document.title = t('title.home');
  showSection('view-home');
  renderHome();
};

/* ---------- Home (server list) ---------- */

const renderUserCard = () => {
  const card = $('user-card');
  const copy = el('div');
  copy.append(el('span', '', t('home.connected')), el('strong', '', session.user.displayName));
  card.replaceChildren(picture(session.user.avatarUrl, session.user.displayName, 'avatar-fallback'), copy);
};

const guildCard = guild => {
  const link = el('a', 'guild-card');
  link.href = `${BASE}/server/${encodeURIComponent(guild.id)}`;
  link.dataset.nav = '';

  const copy = el('div', 'guild-card-copy');
  const tags = el('div');
  tags.append(
    tag(guild.availableWorkers === 1 ? t('servers.bot') : t('servers.bots', {count: guild.availableWorkers}), 'ok'),
    tag(guild.owner ? t('servers.owner') : t('servers.admin')),
  );
  copy.append(el('strong', '', guild.name), tags);
  link.append(picture(guild.iconUrl, guild.name), copy, icon('arrowRight'));
  return link;
};

const renderHome = () => {
  renderUserCard();
  const grid = $('guild-grid');
  grid.replaceChildren(...session.guilds.map(guildCard));
  $('guild-empty').hidden = session.guilds.length > 0;

  const inviteCard = $(NEW_SERVER_ANCHOR);
  inviteCard.hidden = !session.superAdmin;
  if (session.superAdmin) {
    void loadInvites();
    // "/add" lands here with #nuovo-server: the card was hidden at load, so scroll once now.
    if (window.location.hash === `#${NEW_SERVER_ANCHOR}`) {
      inviteCard.scrollIntoView({block: 'start'});
    }
  }
};

let inviteRequest = 0;
const loadInvites = async () => {
  const request = ++inviteRequest;
  const list = $('invite-list');
  showNotice($('invite-message'), '');

  try {
    const {bots} = await api('/api/super/bots');
    if (request !== inviteRequest) return;

    const tiles = (Array.isArray(bots) ? bots : []).map(bot => {
      const tile = el('a', 'invite-tile');
      tile.href = `/invite/${encodeURIComponent(bot.workerId)}?lang=${LOCALE}`;
      const copy = el('div');
      copy.append(
        el('strong', '', bot.bot ? bot.bot.username : bot.workerId),
        el('span', 'mono', bot.workerId),
      );
      tile.append(icon('plus', 16), copy, tag(bot.ready ? t('super.ready') : t('super.offline'), bot.ready ? 'ok' : 'danger'));
      tile.setAttribute('aria-label', `${t('invite.add')} · ${bot.bot ? bot.bot.username : bot.workerId}`);
      return tile;
    });
    list.replaceChildren(...tiles);
    if (tiles.length === 0) showNotice($('invite-message'), t('invite.empty'));
  } catch (error) {
    if (request !== inviteRequest) return;
    list.replaceChildren();
    handleFailure(error, () => showNotice($('invite-message'), t('invite.failed')));
  }
};

/* ---------- Guild app shell ---------- */

let selectedGuildId = null;
let guildDetails = null;
let activeTab = 'overview';
const selectedWorkers = new Set();
const enabledSettings = new Set();
let editingGroupId = null;
const preservedUnavailableWorkers = new Set();

const onlineWorkers = () => (guildDetails ? guildDetails.workers.filter(worker => worker.ok) : []);
const availableWorkerIds = () => new Set(onlineWorkers().map(worker => worker.workerId));

const workerName = worker => (worker && worker.ok && worker.value && worker.value.status && worker.value.status.bot
  ? worker.value.status.bot.username
  : worker ? worker.workerId : '');

const workerDisplayName = workerId => {
  const worker = guildDetails ? guildDetails.workers.find(candidate => candidate.workerId === workerId) : undefined;
  return worker ? workerName(worker) : workerId;
};

const setPill = (text, mode) => {
  const pill = $('guild-pill');
  pill.className = `live-pill${mode ? ` is-${mode}` : ''}`;
  $('guild-pill-text').textContent = text;
};

const setTab = tab => {
  activeTab = tab;
  for (const navButton of document.querySelectorAll('.sidebar-nav [data-tab]')) {
    const active = navButton.dataset.tab === tab;
    navButton.classList.toggle('active', active);
    navButton.setAttribute('aria-current', active ? 'page' : 'false');
  }

  $('tab-overview').hidden = tab !== 'overview';
  $('tab-settings').hidden = tab !== 'settings';
  $('tab-groups').hidden = tab !== 'groups';
  $('tab-log').hidden = tab !== 'log';
  // The Log tab always applies to every bot of the server, so the bot selection is hidden there too.
  $('selection-panel').hidden = tab === 'overview' || tab === 'log';
  $('workspace-kicker').textContent = t(`guild.tabs.${tab}`).toUpperCase();
  if (tab === 'log') void loadMeta();
};

const renderSidebar = guild => {
  const summary = session.guilds.find(candidate => candidate.id === guild.id);
  const copy = el('div');
  copy.append(el('strong', '', guild.name), tag(t('guild.online', {count: onlineWorkers().length}), 'ok'));
  $('sidebar-guild').replaceChildren(picture(guild.iconUrl, guild.name), copy);
  $('sidebar-access').textContent = summary && summary.owner ? t('guild.accessOwner') : t('guild.accessAdmin');

  const user = el('div');
  user.append(el('strong', '', session.user.displayName), el('span', 'mono', `@${session.user.username}`));
  $('sidebar-user').replaceChildren(picture(session.user.avatarUrl, session.user.displayName, 'avatar-fallback'), user);
};

const playerFor = worker => {
  const players = worker.value && worker.value.status && Array.isArray(worker.value.status.players) ? worker.value.status.players : [];
  return players.find(player => player.guildId === selectedGuildId);
};

const renderOverview = () => {
  const workers = guildDetails.workers;
  const online = onlineWorkers();
  const inVoice = online.filter(worker => {
    const player = playerFor(worker);
    return Boolean(player && player.connected);
  });

  $('stat-bots').textContent = String(workers.length);
  $('stat-online').textContent = String(online.length);
  $('stat-voice').textContent = String(inVoice.length);
  $('stat-groups').textContent = String((guildDetails.groups || []).length);

  const rows = workers.map(worker => {
    const row = el('article', 'bot-row');
    const meta = el('div', 'row-meta');
    const tags = el('div', 'row-tags');

    if (worker.ok) {
      const value = worker.value || {};
      const status = value.status || {};
      const settings = value.settings || {};
      const botId = status.bot ? status.bot.id : '—';
      row.append(identity(status.bot ? status.bot.avatarUrl : null, workerName(worker), `${worker.workerId} · ${botId}`, {round: true}));
      meta.append(
        el('span', '', t('overview.volume', {value: settings.defaultVolume ?? '?'})),
        el('span', '', t('overview.playlist', {value: settings.playlistLimit ?? '?'})),
      );
      const player = playerFor(worker);
      tags.append(
        status.discordReady === false ? state(t('overview.notReady'), 'warn') : state(t('overview.ready'), 'ok'),
        player && player.connected ? state(t('overview.inVoice'), 'info') : state(t('overview.idle')),
      );
    } else {
      row.append(identity(null, worker.workerId, worker.workerId, {round: true}));
      meta.append(el('span', 'mono', t('overview.unavailable', {error: worker.error || t('guild.error')})));
      tags.append(state(t('overview.offline'), 'danger'));
    }

    row.append(meta, tags);
    return row;
  });

  $('overview-bots').replaceChildren(...rows);
  $('overview-empty').hidden = rows.length > 0;
};

/* Worker selection */

const updateSelectionSummary = () => {
  const count = selectedWorkers.size;
  $('selection-summary').textContent = count === 1 ? t('selection.summaryOne') : t('selection.summaryMany', {count});
  $('apply-button').disabled = count === 0;

  for (const option of $('worker-grid').querySelectorAll('.worker-option')) {
    const checkbox = option.querySelector('input[type="checkbox"]');
    checkbox.checked = selectedWorkers.has(checkbox.value);
    option.classList.toggle('selected', checkbox.checked);
  }

  syncSuggestedValues();
};

const renderWorkerSelection = () => {
  const options = onlineWorkers().map(worker => {
    const option = el('label', 'worker-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = worker.workerId;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedWorkers.add(worker.workerId);
      else selectedWorkers.delete(worker.workerId);
      updateSelectionSummary();
    });

    const settings = (worker.value || {}).settings || {};
    const copy = el('div');
    copy.append(
      el('strong', '', workerName(worker)),
      el('span', 'mono', `${worker.workerId} · vol ${settings.defaultVolume ?? '?'}% · playlist ${settings.playlistLimit ?? '?'}`),
    );
    option.append(checkbox, copy);
    return option;
  });

  $('worker-grid').replaceChildren(...options);
  $('worker-empty').hidden = options.length > 0;
};

const setWorkerSelection = workerIds => {
  const available = availableWorkerIds();
  selectedWorkers.clear();
  for (const workerId of workerIds) {
    if (available.has(workerId)) selectedWorkers.add(workerId);
  }

  updateSelectionSummary();
};

/* Settings */

const settingRow = key => $('settings-form').querySelector(`.setting-row[data-key="${key}"]`);

const setSettingEnabled = (definition, enabled) => {
  const row = settingRow(definition.key);
  if (!row) return;
  if (enabled) enabledSettings.add(definition.key);
  else enabledSettings.delete(definition.key);

  row.classList.toggle('is-enabled', enabled);
  const toggle = row.querySelector('.switch');
  toggle.classList.toggle('on', enabled);
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  row.querySelector('.setting-input').disabled = !enabled;
};

const settingControl = definition => {
  const row = el('div', 'setting-row');
  row.dataset.key = definition.key;

  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', 'false');
  toggle.setAttribute('aria-label', t('settings.toggle', {label: settingLabel(definition)}));
  toggle.append(el('i'));
  toggle.addEventListener('click', () => {
    setSettingEnabled(definition, !enabledSettings.has(definition.key));
  });

  const copy = el('div', 'setting-copy');
  copy.append(el('strong', '', settingLabel(definition)), el('span', '', settingHint(definition)));

  const mixed = tag(t('settings.mixed'), 'warn');
  mixed.classList.add('setting-mixed');
  mixed.hidden = true;

  let input;
  if (definition.type === 'select') {
    input = document.createElement('select');
    const empty = el('option', '', t('settings.choose'));
    empty.value = '';
    input.append(empty);
    for (const value of definition.options) {
      const option = el('option', '', t(`settings.localeOptions.${value}`));
      option.value = value;
      input.append(option);
    }
  } else if (definition.type === 'boolean') {
    input = document.createElement('select');
    const empty = el('option', '', t('settings.choose'));
    empty.value = '';
    const yes = el('option', '', t('settings.yes'));
    yes.value = 'true';
    const no = el('option', '', t('settings.no'));
    no.value = 'false';
    input.append(empty, yes, no);
  } else {
    input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = String(definition.min);
    input.max = String(definition.max);
    input.step = '1';
  }

  input.className = 'setting-input';
  input.dataset.key = definition.key;
  input.disabled = true;
  input.setAttribute('aria-label', settingLabel(definition));

  row.append(toggle, copy, mixed, input);
  return row;
};

const renderSettingsForm = () => {
  $('settings-form').replaceChildren(...SETTINGS.map(settingControl));
};

/** Pre-fills each field that is not being edited with the shared value of the selection. */
const syncSuggestedValues = () => {
  const workers = onlineWorkers().filter(worker => selectedWorkers.has(worker.workerId));

  for (const definition of SETTINGS) {
    const row = settingRow(definition.key);
    if (!row) continue;
    const input = row.querySelector('.setting-input');
    const mixedTag = row.querySelector('.setting-mixed');

    const values = workers.map(worker => ((worker.value || {}).settings || {})[definition.key]);
    const first = values[0];
    const mixed = values.length > 1 && !values.every(value => value === first);
    mixedTag.hidden = !mixed;

    if (input instanceof HTMLInputElement) {
      input.placeholder = mixed ? t('settings.mixed') : '';
    } else if (input.options.length > 0) {
      input.options[0].textContent = mixed ? t('settings.mixed') : t('settings.choose');
    }

    if (enabledSettings.has(definition.key)) continue;
    input.value = !mixed && first !== undefined && first !== null ? String(first) : '';
  }
};

const collectSettings = () => {
  const settings = {};

  for (const definition of SETTINGS) {
    if (!enabledSettings.has(definition.key)) continue;
    const input = settingRow(definition.key).querySelector('.setting-input');
    const label = settingLabel(definition);

    if (definition.type === 'select') {
      if (!definition.options.includes(input.value)) throw new Error(t('settings.chooseValue', {label}));
      settings[definition.key] = input.value;
      continue;
    }

    if (definition.type === 'boolean') {
      if (input.value === '') throw new Error(t('settings.chooseValue', {label}));
      settings[definition.key] = input.value === 'true';
      continue;
    }

    if (input.value === '') throw new Error(t('settings.enterValue', {label}));
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < definition.min || value > definition.max) {
      throw new Error(t('settings.outOfRange', {label, min: definition.min, max: definition.max}));
    }

    settings[definition.key] = value;
  }

  if (Object.keys(settings).length === 0) {
    throw new Error(t('settings.nothing'));
  }

  return settings;
};

const applySettings = async () => {
  if (!selectedGuildId || selectedWorkers.size === 0) return;
  const guildId = selectedGuildId;
  setMessage($('form-message'), '');

  let settings;
  try {
    settings = collectSettings();
  } catch (error) {
    setMessage($('form-message'), error.message, 'error');
    return;
  }

  $('apply-button').disabled = true;
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(guildId)}`, mutation('PATCH', {
      workerIds: [...selectedWorkers],
      settings,
    }));

    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    const selection = [...selectedWorkers];
    await loadGuild(guildId, {keepSelection: selection, keepTab: true});
    if (selectedGuildId !== guildId) return;

    for (const definition of SETTINGS) setSettingEnabled(definition, false);
    syncSuggestedValues();
    if (failed === 0) {
      toast(t('settings.applied'));
    } else {
      setMessage($('form-message'), t('settings.partial', {count: failed}), 'error');
    }
  } catch (error) {
    handleFailure(error, message => setMessage($('form-message'), message, 'error'));
  } finally {
    $('apply-button').disabled = selectedWorkers.size === 0;
  }
};

/* Groups */

const resetGroupEditor = () => {
  editingGroupId = null;
  preservedUnavailableWorkers.clear();
  $('group-name').value = '';
  $('group-editor-title').textContent = t('groups.newTitle');
  $('group-editor-hint').textContent = t('groups.newHint');
  $('save-group').textContent = t('groups.create');
  $('cancel-group-edit').hidden = true;
  $('group-offline-row').hidden = true;
  $('group-offline-note').textContent = '';
};

const selectGroup = group => {
  const available = availableWorkerIds();
  const online = group.workerIds.filter(workerId => available.has(workerId));
  const unavailable = group.workerIds.length - online.length;
  setWorkerSelection(online);
  setMessage(
    $('group-message'),
    unavailable === 0
      ? t('groups.selected', {name: group.name})
      : t('groups.selectedPartial', {name: group.name, count: unavailable}),
    unavailable === 0 ? 'success' : 'muted',
  );
};

const editGroup = group => {
  resetGroupEditor();
  editingGroupId = group.id;
  $('group-name').value = group.name;
  $('group-editor-title').textContent = t('groups.editTitle', {name: group.name});
  $('group-editor-hint').textContent = t('groups.editHint');
  $('save-group').textContent = t('groups.save');
  $('cancel-group-edit').hidden = false;

  const available = availableWorkerIds();
  for (const workerId of group.workerIds) {
    if (!available.has(workerId)) preservedUnavailableWorkers.add(workerId);
  }

  setWorkerSelection(group.workerIds);
  if (preservedUnavailableWorkers.size > 0) {
    $('group-offline-row').hidden = false;
    $('group-offline-note').textContent = t('groups.preserved', {count: preservedUnavailableWorkers.size});
  }

  $('group-name').focus();
};

const deleteGroup = async group => {
  if (!window.confirm(t('groups.confirmDelete', {name: group.name}))) return;
  const guildId = selectedGuildId;

  try {
    await api(
      `/api/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(group.id)}`,
      mutation('DELETE'),
    );
    if (editingGroupId === group.id) resetGroupEditor();
    await loadGuild(guildId, {keepSelection: [...selectedWorkers], keepTab: true});
    toast(t('groups.deleted'));
  } catch (error) {
    handleFailure(error, message => setMessage($('group-message'), message, 'error'));
  }
};

const renderGroups = () => {
  const groups = guildDetails.groups || [];
  const available = availableWorkerIds();

  const rows = groups.map(group => {
    const row = el('article', 'group-row');
    const copy = el('div');
    const unavailable = group.workerIds.filter(workerId => !available.has(workerId));
    copy.append(
      el('strong', '', group.name),
      el('span', '', t('groups.members', {count: group.workerIds.length, names: group.workerIds.map(workerDisplayName).join(', ')})),
    );
    if (unavailable.length > 0) {
      copy.append(tag(t('groups.unavailable', {count: unavailable.length}), 'warn'));
    }

    const actions = el('div', 'row-actions');
    actions.append(
      button(t('groups.select'), 'button-secondary button-sm', () => selectGroup(group)),
      button(t('groups.edit'), 'button-ghost button-sm', () => editGroup(group)),
      button(t('groups.remove'), 'button-danger button-sm', () => {
        void deleteGroup(group);
      }),
    );
    row.append(copy, actions);
    return row;
  });

  $('group-list').replaceChildren(...rows);
  $('group-empty').hidden = rows.length > 0;
};

const saveGroup = async () => {
  const name = $('group-name').value.trim();
  if (!name) {
    setMessage($('group-message'), t('groups.nameRequired'), 'error');
    return;
  }

  const workerIds = [...new Set([...selectedWorkers, ...preservedUnavailableWorkers])];
  if (workerIds.length === 0) {
    setMessage($('group-message'), t('groups.membersRequired'), 'error');
    return;
  }

  const guildId = selectedGuildId;
  const editing = editingGroupId !== null;
  const endpoint = editing
    ? `/api/guilds/${encodeURIComponent(guildId)}/groups/${encodeURIComponent(editingGroupId)}`
    : `/api/guilds/${encodeURIComponent(guildId)}/groups`;

  $('save-group').disabled = true;
  setMessage($('group-message'), '');
  try {
    await api(endpoint, mutation(editing ? 'PATCH' : 'POST', {name, workerIds}));
    resetGroupEditor();
    await loadGuild(guildId, {keepSelection: [...selectedWorkers], keepTab: true});
    toast(editing ? t('groups.updated') : t('groups.created'));
  } catch (error) {
    handleFailure(error, message => setMessage($('group-message'), message, 'error'));
  } finally {
    $('save-group').disabled = false;
  }
};

/* Status log: the "Bot avviato" message, one setting for every bot of the server */

const MAX_STATUS_ROLES = 10;

let guildMeta = null;
let metaGuildId = null;
let metaRequest = 0;
let logDraft = {channelId: '', roleIds: []};
let logDirty = false;
let logBusy = false;

const workerSettings = worker => ((worker && worker.value) || {}).settings || {};

const savedChannelOf = worker => {
  const value = workerSettings(worker).statusChannelId;
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;
};

const savedRolesOf = worker => list(workerSettings(worker).statusMentionRoleIds)
  .filter(roleId => typeof roleId === 'string' && SNOWFLAKE.test(roleId));

/** The status setting shared by the online bots; `mixed*` when they disagree ("valori diversi tra i bot"). */
const savedStatus = () => {
  const workers = onlineWorkers();
  const channels = workers.map(savedChannelOf);
  const roleKeys = workers.map(worker => [...savedRolesOf(worker)].sort().join(','));
  const mixedChannel = new Set(channels).size > 1;
  const mixedRoles = new Set(roleKeys).size > 1;
  return {
    workers,
    mixedChannel,
    mixedRoles,
    channelId: mixedChannel || workers.length === 0 ? null : channels[0],
    roleIds: mixedRoles || workers.length === 0 ? [] : savedRolesOf(workers[0]),
    anyConfigured: channels.some(channelId => channelId !== null),
  };
};

const metaChannels = () => (guildMeta ? list(guildMeta.channels) : []);
const metaRoles = () => (guildMeta ? list(guildMeta.roles) : []);
const findChannel = channelId => metaChannels().find(channel => channel.id === channelId);
const findRole = roleId => metaRoles().find(role => role.id === roleId);

/** Online bots that reported they cannot post in the channel (bots that did not answer are unknown, not listed). */
const botsLackingPost = channel => {
  if (!guildMeta || !channel) return [];
  const asked = new Set(list(guildMeta.workerIds));
  const failed = new Set(list(guildMeta.failed).map(entry => entry && entry.workerId));
  const postable = new Set(list(channel.postableBy));
  return onlineWorkers()
    .filter(worker => asked.has(worker.workerId) && !failed.has(worker.workerId) && !postable.has(worker.workerId))
    .map(worker => workerName(worker));
};

const roleColor = role => {
  const color = role ? Number(role.color) : 0;
  return Number.isInteger(color) && color > 0 && color <= 0xffffff ? `#${color.toString(16).padStart(6, '0')}` : '';
};

const statusErrorLabel = code => {
  const label = lookup(`log.errors.${code}`);
  return typeof label === 'string' ? label : String(code || '—');
};

const channelLabel = channel => `#${channel.name}${channel.type === 'announcement' ? ` (${t('log.announcement')})` : ''}`;

const renderLogChannels = saved => {
  const select = $('log-channel');
  const placeholder = el('option', '', saved.mixedChannel && !logDirty ? t('log.mixedChoose') : t('log.chooseChannel'));
  placeholder.value = '';
  const nodes = [placeholder];

  if (logDraft.channelId && !findChannel(logDraft.channelId)) {
    const missing = el('option', '', t('log.unknownChannel', {id: logDraft.channelId}));
    missing.value = logDraft.channelId;
    nodes.push(missing);
  }

  // The orchestrator sends the channels in Discord sidebar order: group them by category.
  const groups = new Map();
  for (const channel of metaChannels()) {
    const parent = typeof channel.parentName === 'string' ? channel.parentName : '';
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(channel);
  }

  for (const [parent, channels] of groups) {
    const options = channels.map(channel => {
      const lacking = botsLackingPost(channel);
      const label = lacking.length > 0
        ? `${channelLabel(channel)} · ⚠ ${t('log.cannotPostShort', {names: lacking.join(', ')})}`
        : channelLabel(channel);
      const option = el('option', '', label);
      option.value = channel.id;
      return option;
    });

    if (parent === '') {
      nodes.push(...options);
    } else {
      const group = document.createElement('optgroup');
      group.label = parent;
      group.append(...options);
      nodes.push(group);
    }
  }

  select.replaceChildren(...nodes);
  select.value = logDraft.channelId || '';
  select.disabled = logBusy || !guildMeta || saved.workers.length === 0;

  const lacking = botsLackingPost(findChannel(logDraft.channelId));
  const warning = $('log-channel-warning');
  warning.textContent = lacking.length > 0 ? t('log.cannotPost', {names: lacking.join(', ')}) : '';
  warning.hidden = lacking.length === 0;
};

const renderLogRoles = saved => {
  const full = logDraft.roleIds.length >= MAX_STATUS_ROLES;
  const select = $('log-role-add');
  const first = el('option', '', full ? t('log.maxRoles') : t('log.addRole'));
  first.value = '';
  const options = metaRoles().map(role => {
    const option = el('option', '', `@${role.name}`);
    option.value = role.id;
    option.disabled = logDraft.roleIds.includes(role.id);
    return option;
  });
  select.replaceChildren(first, ...options);
  select.value = '';
  select.disabled = logBusy || !guildMeta || full || saved.workers.length === 0;

  $('log-role-list').replaceChildren(...logDraft.roleIds.map(roleId => {
    const role = findRole(roleId);
    const name = role ? `@${role.name}` : `@${roleId} · ${t('log.unknownRole')}`;
    const chip = el('span', 'chip log-role-chip');
    const dot = el('span', 'role-dot');
    const color = roleColor(role);
    // CSSOM property, not a style attribute: allowed by the style-src 'self' policy.
    if (color) dot.style.backgroundColor = color;
    const remove = el('button', '', '×');
    remove.type = 'button';
    remove.disabled = logBusy;
    remove.setAttribute('aria-label', t('log.removeRole', {name}));
    remove.addEventListener('click', () => {
      logDraft = {...logDraft, roleIds: logDraft.roleIds.filter(id => id !== roleId)};
      logDirty = true;
      renderLog();
    });
    chip.append(dot, el('span', '', name), remove);
    return chip;
  }));
  $('log-no-roles').hidden = logDraft.roleIds.length > 0;

  const silent = logDraft.roleIds.map(findRole).filter(role => role && !role.mentionable).map(role => `@${role.name}`);
  const warning = $('log-role-warning');
  warning.textContent = silent.length > 0 ? t('log.roleNotMentionable', {names: silent.join(', ')}) : '';
  warning.hidden = silent.length === 0;
};

/** Static mock of the Discord message (Sentinel embed style); the real one is in the bot language of the server. */
const renderLogPreview = () => {
  const first = onlineWorkers()[0];
  const status = first && first.value && first.value.status ? first.value.status : {};
  const bot = status.bot || null;
  const botName = bot ? bot.username : t('log.previewBot');
  const botId = bot ? bot.id : '000000000000000000';
  const time = new Intl.DateTimeFormat(INTL_LOCALE, {timeStyle: 'short'}).format(new Date());

  const head = el('div', 'discord-head');
  head.append(el('strong', '', botName), el('span', 'discord-badge', 'BOT'), el('span', 'discord-time', `${t('log.previewToday')} ${time}`));

  const body = el('div', 'discord-body');
  body.append(head);

  const mentions = logDraft.roleIds.map(findRole).filter(Boolean);
  if (mentions.length > 0) {
    const line = el('div', 'discord-mentions');
    line.append(...mentions.map(role => el('span', 'discord-mention', `@${role.name}`)));
    body.append(line);
  }

  const field = (name, value) => {
    const node = el('div', 'discord-field');
    node.append(el('strong', '', name), el('span', '', value));
    return node;
  };

  const identityLine = `${botName} · @${botName} · ${botId}`;
  const embed = el('div', 'discord-embed');
  embed.append(
    el('strong', 'discord-embed-title', t('log.previewEmbedTitle')),
    el('p', '', t('log.previewDescription', {name: botName})),
    field(t('log.previewAuthor'), identityLine),
    field(t('log.previewDetails'), `Guild Count: ${list(status.guilds).length || 1}\nBot: ${identityLine}`),
    el('small', 'discord-footer', `${window.location.hostname} · ${t('log.previewToday')} ${time}`),
  );
  body.append(embed);

  const message = el('div', 'discord-message');
  message.append(picture(bot ? bot.avatarUrl : null, botName, 'avatar-fallback', 'round'), body);
  $('log-preview').replaceChildren(message);
};

const renderLog = () => {
  if (!guildDetails) return;
  const saved = savedStatus();
  if (!logDirty) logDraft = {channelId: saved.channelId || '', roleIds: [...saved.roleIds]};

  const online = saved.workers.length;
  const mixed = saved.mixedChannel || saved.mixedRoles;
  $('log-summary').textContent = online === 0 ? t('log.noBots') : t('log.summary', {count: online});
  $('log-mixed').hidden = !mixed;

  const stateTag = $('log-state');
  if (mixed) {
    stateTag.className = 'tag tag-warn';
    stateTag.textContent = t('log.mixed');
  } else if (saved.channelId) {
    const channel = findChannel(saved.channelId);
    stateTag.className = 'tag tag-ok';
    stateTag.textContent = t('log.stateOn', {channel: channel ? channel.name : saved.channelId});
  } else {
    stateTag.className = 'tag';
    stateTag.textContent = t('log.stateOff');
  }

  renderLogChannels(saved);
  renderLogRoles(saved);
  renderLogPreview();
  $('log-save').disabled = logBusy || online === 0 || !guildMeta;
  $('log-disable').disabled = logBusy || online === 0 || !saved.anyConfigured;
  $('log-test').disabled = logBusy || online === 0 || !saved.anyConfigured;
};

const setLogBusy = busy => {
  logBusy = busy;
  renderLog();
};

/** Channels and roles of the server for the pickers; loaded when the Log tab opens. */
const loadMeta = async (force = false) => {
  const guildId = selectedGuildId;
  if (!guildId) return;
  if (!force && metaGuildId === guildId && guildMeta) {
    renderLog();
    return;
  }

  const request = ++metaRequest;
  showNotice($('log-message'), '');
  setMessage($('log-form-message'), t('log.loading'));
  try {
    const meta = await api(`/api/guilds/${encodeURIComponent(guildId)}/meta`);
    if (request !== metaRequest || selectedGuildId !== guildId) return;
    guildMeta = meta && typeof meta === 'object' ? meta : null;
    metaGuildId = guildId;
    setMessage($('log-form-message'), '');
  } catch (error) {
    if (request !== metaRequest || selectedGuildId !== guildId) return;
    guildMeta = null;
    metaGuildId = null;
    setMessage($('log-form-message'), '');
    handleFailure(error, message => showNotice($('log-message'), `${t('log.metaFailed')} ${message}`));
  }

  renderLog();
};

/** Saves the status settings on every online bot of the server (same plumbing as the Settings tab). */
const applyStatusSettings = async (settings, successMessage) => {
  const guildId = selectedGuildId;
  const workerIds = onlineWorkers().map(worker => worker.workerId);
  if (!guildId || workerIds.length === 0) return;
  setMessage($('log-form-message'), '');
  showNotice($('log-message'), '');
  setLogBusy(true);
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(guildId)}`, mutation('PATCH', {workerIds, settings}));
    const failed = list(result.failed).filter(entry => entry && typeof entry.workerId === 'string');
    logDirty = false;
    $('log-results').replaceChildren();
    await loadGuild(guildId, {keepSelection: [...selectedWorkers], keepTab: true});
    if (selectedGuildId !== guildId) return;
    if (failed.length === 0) {
      toast(successMessage);
    } else {
      const names = failed.map(entry => `${workerDisplayName(entry.workerId)} (${statusErrorLabel(entry.code || entry.error)})`);
      setMessage($('log-form-message'), t('log.partial', {names: names.join(', ')}), 'error');
    }
  } catch (error) {
    handleFailure(error, message => setMessage($('log-form-message'), message, 'error'));
  } finally {
    setLogBusy(false);
  }
};

const saveLog = async () => {
  if (!logDraft.channelId) {
    setMessage($('log-form-message'), t('log.channelRequired'), 'error');
    $('log-channel').focus();
    return;
  }

  await applyStatusSettings({statusChannelId: logDraft.channelId, statusMentionRoleIds: [...logDraft.roleIds]}, t('log.saved'));
};

const disableLog = async () => {
  if (!window.confirm(t('log.confirmDisable'))) return;
  await applyStatusSettings({statusChannelId: null}, t('log.disabled'));
};

const renderLogResults = results => {
  $('log-results').replaceChildren(...results.map(result => {
    const row = el('div', 'status-result');
    const copy = el('div');
    copy.append(el('strong', '', workerDisplayName(result.workerId)), el('span', 'mono', result.workerId));
    row.append(copy, result.ok === true ? tag(t('log.posted'), 'ok') : tag(statusErrorLabel(result.error), 'danger'));
    return row;
  }));
};

/** Every online bot posts the test message with its saved setting; one result row per bot. */
const testLog = async () => {
  const guildId = selectedGuildId;
  const workerIds = onlineWorkers().map(worker => worker.workerId);
  if (!guildId || workerIds.length === 0) return;
  showNotice($('log-message'), '');
  setMessage($('log-form-message'), logDirty ? t('log.unsaved') : '');
  toast(t('log.testing'));
  setLogBusy(true);
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(guildId)}/status-channel/test`, mutation('POST', {workerIds}));
    if (selectedGuildId !== guildId) return;
    const results = list(result.results).filter(item => item && typeof item.workerId === 'string');
    renderLogResults(results);
    const ok = results.filter(item => item.ok === true).length;
    const failed = results.length - ok;
    if (failed > 0) {
      setMessage($('log-form-message'), t('log.testPartial', {ok, failed}), 'error');
    } else {
      toast(t('log.testOk', {count: ok}));
    }
  } catch (error) {
    handleFailure(error, message => setMessage($('log-form-message'), message, 'error'));
  } finally {
    setLogBusy(false);
  }
};

const resetLog = () => {
  guildMeta = null;
  metaGuildId = null;
  metaRequest += 1;
  logDraft = {channelId: '', roleIds: []};
  logDirty = false;
  logBusy = false;
  $('log-results').replaceChildren();
  $('log-role-list').replaceChildren();
  $('log-preview').replaceChildren();
  setMessage($('log-form-message'), '');
  showNotice($('log-message'), '');
};

/* Loading a guild */

/**
 * Loads one guild. Responses that arrive after the user moved to another guild
 * (or left the guild view) are ignored.
 */
const loadGuild = async (guildId, options = {}) => {
  selectedGuildId = guildId;
  setPill(t('guild.loading'), 'idle');

  const details = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
  if (selectedGuildId !== guildId) return;

  guildDetails = details;
  document.title = t('title.guild', {name: details.guild.name});
  $('guild-title').textContent = details.guild.name;
  $('guild-subtitle').textContent = t('guild.subtitle');
  showNotice($('guild-message'), '');

  renderSidebar(details.guild);
  renderOverview();
  renderWorkerSelection();
  renderGroups();
  renderLog();
  setWorkerSelection(options.keepSelection || []);
  if (!options.keepTab) setTab('overview');

  const online = onlineWorkers().length;
  setPill(t('guild.online', {count: online}), online > 0 ? '' : 'idle');
};

const openGuild = async guildId => {
  if (guildId === selectedGuildId && guildDetails && guildDetails.guildId === guildId) {
    return;
  }

  guildDetails = null;
  for (const definition of SETTINGS) setSettingEnabled(definition, false);
  resetGroupEditor();
  setMessage($('form-message'), '');
  setMessage($('group-message'), '');
  $('guild-title').textContent = '';
  $('guild-subtitle').textContent = '';
  $('sidebar-guild').replaceChildren();
  $('overview-bots').replaceChildren();
  $('worker-grid').replaceChildren();
  $('group-list').replaceChildren();
  resetLog();
  selectedWorkers.clear();
  setTab('overview');

  try {
    await loadGuild(guildId);
  } catch (error) {
    if (selectedGuildId !== guildId) return;
    setPill(t('guild.error'), 'error');
    handleFailure(error, message => showNotice($('guild-message'), message));
  }
};

/* ---------- Super console ---------- */

let overviewRequest = 0;
let overview = null;

const loadOverview = async () => {
  const request = ++overviewRequest;
  showNotice($('super-message'), '');

  if (!session.superAdmin) {
    $('super-loading').hidden = true;
    $('super-content').hidden = true;
    showNotice($('super-message'), t('super.denied'));
    return;
  }

  $('super-loading').hidden = overview !== null;
  try {
    const data = await api('/api/super/overview');
    if (request !== overviewRequest || currentRoute().view !== 'super') return;
    overview = data;
    renderOverviewData();
    $('super-content').hidden = false;
  } catch (error) {
    if (request !== overviewRequest) return;
    handleFailure(error, message => showNotice($('super-message'), message));
  } finally {
    if (request === overviewRequest) $('super-loading').hidden = true;
  }
};

const list = value => (Array.isArray(value) ? value : []);

const botNameById = () => new Map(list(overview.workers).map(worker => [worker.id, worker.bot ? worker.bot.username : worker.id]));

const renderSuperWorker = worker => {
  const row = el('article', 'super-worker');
  const name = worker.bot ? worker.bot.username : worker.id;
  row.append(identity(worker.bot ? worker.bot.avatarUrl : null, name, worker.bot ? `${worker.id} · ${worker.bot.id}` : worker.id, {round: true}));

  const tags = el('div', 'row-tags');
  if (!worker.reachable) tags.append(state(t('super.offline'), 'danger'));
  else if (worker.ready) tags.append(state(t('super.ready'), 'ok'));
  else tags.append(state(t('super.notReady'), 'warn'));

  const meta = el('div', 'row-meta');
  meta.append(
    el('span', '', t('super.botMeta', {guilds: formatNumber(worker.guildCount), players: formatNumber(worker.activePlayers)})),
    el('span', 'mono', t('super.uptime', {value: worker.reachable ? formatUptime(worker.uptimeSeconds) : '—'})),
  );

  const actions = el('div', 'row-actions');
  if (worker.bot) {
    const invite = el('a', 'button button-secondary button-sm', t('invite.add'));
    invite.href = `/invite/${encodeURIComponent(worker.id)}?lang=${LOCALE}`;
    actions.append(invite);
  } else {
    const unavailable = el('button', 'button button-secondary button-sm', t('invite.add'));
    unavailable.type = 'button';
    unavailable.disabled = true;
    actions.append(unavailable);
  }

  row.append(tags, meta, actions);
  return row;
};

const renderSuperGuild = (guild, names) => {
  const row = el('article', 'super-guild');
  row.append(identity(guild.iconUrl, guild.name, guild.id));

  const meta = el('div', 'row-meta');
  meta.append(
    el('span', 'mono', t('super.owner', {id: guild.ownerId || '—'})),
    el('span', '', t('super.members', {count: typeof guild.memberCount === 'number' ? formatNumber(guild.memberCount) : '—'})),
  );

  const tags = el('div', 'row-tags');
  if (guild.blocked) tags.append(tag(t('super.blocked'), 'danger'));
  const chips = el('div', 'chip-list');
  for (const workerId of list(guild.workerIds)) {
    chips.append(el('span', 'chip', names.get(workerId) || workerId));
  }

  tags.append(chips);

  const actions = el('div', 'row-actions');
  actions.append(button(t('super.leave'), 'button-secondary button-sm', () => {
    void leaveGuild(guild);
  }));
  const block = button(t('super.blockLeave'), 'button-danger button-sm', () => {
    void blockGuild(guild);
  });
  block.disabled = Boolean(guild.blocked);
  actions.append(block);

  row.append(meta, tags, actions);
  return row;
};

const kindLabel = kind => (kind === 'USER' ? t('super.user') : t('super.guild'));

const renderBlock = block => {
  const row = el('div', 'block-row');
  const copy = el('div');
  const title = el('strong');
  title.append(document.createTextNode(`${kindLabel(block.kind)} · `), el('span', 'mono', block.subjectId));
  const by = block.createdBy && block.createdBy.username ? ` · ${t('super.by', {name: block.createdBy.username})}` : '';
  copy.append(title, el('span', '', `${block.reason || '—'} · ${formatDate(block.createdAt)}${by}`));
  row.append(
    copy,
    tag(t('super.blocked'), 'danger'),
    button(t('super.unblock'), 'button-secondary button-sm', () => {
      void unblock(block);
    }),
  );
  return row;
};

const OUTCOME_VARIANT = {ok: 'ok', partial: 'warn', failed: 'danger'};

const outcomeLabel = outcome => {
  const label = lookup(`super.outcome.${outcome}`);
  return typeof label === 'string' ? label : String(outcome || '—');
};

const renderAudit = item => {
  const row = el('div', 'log-row');
  const subject = el('span');
  if (item.subjectType) {
    subject.append(document.createTextNode(`${item.subjectType} · `), el('span', 'mono', item.subjectId || '—'));
  } else {
    subject.textContent = '—';
  }

  const time = el('time', 'mono', formatDate(item.at));
  time.dateTime = typeof item.at === 'string' ? item.at : '';
  row.append(
    el('strong', 'mono', item.action),
    subject,
    el('span', '', item.actor ? item.actor.username || item.actor.userId : '—'),
    tag(outcomeLabel(item.outcome), OUTCOME_VARIANT[item.outcome]),
    time,
  );
  return row;
};

const renderOverviewData = () => {
  const workers = list(overview.workers);
  const guilds = list(overview.guilds);
  const blocks = list(overview.blocks);
  const audit = list(overview.audit);

  const online = workers.filter(worker => worker.reachable && worker.ready).length;
  const bots = $('metric-bots');
  bots.replaceChildren(document.createTextNode(String(online)), el('small', '', `/${workers.length}`));
  $('metric-guilds').textContent = formatNumber(guilds.length);
  $('metric-players').textContent = formatNumber(workers.reduce((sum, worker) => sum + (Number(worker.activePlayers) || 0), 0));
  $('metric-blocks').textContent = formatNumber(blocks.length);

  const names = botNameById();
  $('super-workers').replaceChildren(...workers.map(renderSuperWorker));
  $('super-workers-empty').hidden = workers.length > 0;
  $('super-guilds').replaceChildren(...guilds.map(guild => renderSuperGuild(guild, names)));
  $('super-guilds-empty').hidden = guilds.length > 0;
  $('super-blocks').replaceChildren(...blocks.map(renderBlock));
  $('super-blocks-empty').hidden = blocks.length > 0;
  $('super-audit').replaceChildren(...audit.map(renderAudit));
  $('super-audit-empty').hidden = audit.length > 0;
};

/** Runs a super-admin mutation, then reloads the overview. Returns the response body or null. */
const superAction = async (url, method, body) => {
  showNotice($('super-message'), '');
  try {
    const result = await api(url, mutation(method, body));
    await loadOverview();
    return result || {};
  } catch (error) {
    handleFailure(error, message => showNotice($('super-message'), message));
    return null;
  }
};

const leaveGuild = async guild => {
  if (!window.confirm(t('super.confirmLeave', {name: guild.name}))) return;
  const result = await superAction(`/api/super/guilds/${encodeURIComponent(guild.id)}/leave`, 'POST', {});
  if (!result) return;
  const left = list(result.left).length;
  const failed = list(result.failed).length;
  if (failed > 0) {
    showNotice($('super-message'), t('super.leftPartial', {left, failed}));
  } else {
    toast(t('super.left', {count: left}));
  }
};

const reportBlock = (kind, subjectId, result) => {
  const failed = list(result.failed).length;
  if (failed > 0) {
    showNotice($('super-message'), t('super.blockedPartial', {kind: kindLabel(kind), id: subjectId, failed}));
  } else {
    toast(t('super.blockedDone', {kind: kindLabel(kind), id: subjectId}));
  }
};

const blockGuild = async guild => {
  if (!window.confirm(t('super.confirmBlock', {name: guild.name}))) return;
  const result = await superAction(
    `/api/super/blocks/GUILD/${encodeURIComponent(guild.id)}`,
    'PUT',
    {reason: t('super.blockReasonDefault')},
  );
  if (result) reportBlock('GUILD', guild.id, result);
};

const unblock = async block => {
  if (!window.confirm(t('super.confirmUnblock', {kind: kindLabel(block.kind).toLowerCase(), id: block.subjectId}))) return;
  const result = await superAction(
    `/api/super/blocks/${encodeURIComponent(block.kind)}/${encodeURIComponent(block.subjectId)}`,
    'DELETE',
  );
  if (result) toast(t('super.unblocked', {kind: kindLabel(block.kind), id: block.subjectId}));
};

const submitBlockForm = async form => {
  const kind = form.dataset.kind;
  const subjectId = form.elements.subjectId.value.trim();
  const reason = form.elements.reason.value.trim();

  if (!SNOWFLAKE.test(subjectId)) {
    showNotice($('super-message'), t('super.invalidId'));
    form.elements.subjectId.focus();
    return;
  }

  if (reason.length > 500) {
    showNotice($('super-message'), t('super.reasonTooLong'));
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await superAction(
      `/api/super/blocks/${encodeURIComponent(kind)}/${encodeURIComponent(subjectId)}`,
      'PUT',
      reason ? {reason} : {},
    );
    if (result) {
      form.reset();
      reportBlock(kind, subjectId, result);
    }
  } finally {
    submit.disabled = false;
  }
};

/* ---------- Wiring ---------- */

const logout = async () => {
  try {
    await fetch(`/auth/logout?lang=${LOCALE}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'x-csrf-token': session ? session.csrfToken : ''},
    });
  } finally {
    window.location.assign(DASHBOARD_PATH);
  }
};

const wire = () => {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[data-nav]') : null;
    if (!link || link.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(link.pathname);
  });

  window.addEventListener('popstate', () => {
    render();
  });

  for (const node of document.querySelectorAll('[data-logout]')) {
    node.addEventListener('click', () => {
      void logout();
    });
  }

  for (const navButton of document.querySelectorAll('.sidebar-nav [data-tab]')) {
    navButton.addEventListener('click', () => setTab(navButton.dataset.tab));
  }

  $('select-all').addEventListener('click', () => {
    setWorkerSelection([...availableWorkerIds()]);
  });

  $('select-none').addEventListener('click', () => {
    setWorkerSelection([]);
  });

  $('apply-button').addEventListener('click', () => {
    void applySettings();
  });

  $('save-group').addEventListener('click', () => {
    void saveGroup();
  });

  $('cancel-group-edit').addEventListener('click', () => {
    resetGroupEditor();
  });

  $('drop-offline-members').addEventListener('click', () => {
    preservedUnavailableWorkers.clear();
    $('group-offline-row').hidden = true;
    $('group-offline-note').textContent = '';
  });

  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
  });

  $('log-channel').addEventListener('change', event => {
    logDraft = {...logDraft, channelId: event.target.value};
    logDirty = true;
    renderLog();
  });

  $('log-role-add').addEventListener('change', event => {
    const roleId = event.target.value;
    if (roleId && !logDraft.roleIds.includes(roleId) && logDraft.roleIds.length < MAX_STATUS_ROLES) {
      logDraft = {...logDraft, roleIds: [...logDraft.roleIds, roleId]};
      logDirty = true;
    }

    renderLog();
  });

  $('log-save').addEventListener('click', () => {
    void saveLog();
  });

  $('log-disable').addEventListener('click', () => {
    void disableLog();
  });

  $('log-test').addEventListener('click', () => {
    void testLog();
  });

  $('super-refresh').addEventListener('click', () => {
    void loadOverview();
  });

  for (const form of [$('block-user-form'), $('block-guild-form')]) {
    form.addEventListener('submit', event => {
      event.preventDefault();
      void submitBlockForm(form);
    });
  }
};

const showLoginMessage = () => {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('login');
  if (reason !== 'failed' && reason !== 'blocked') return;

  showNotice($('login-message'), reason === 'blocked' ? t('login.blocked') : t('login.failed'));
  window.history.replaceState(null, '', window.location.pathname + window.location.hash);
};

const boot = async () => {
  const sessionRequest = api('/api/session').catch(() => null);
  await loadStrings();
  applyTranslations();
  renderSettingsForm();
  resetGroupEditor();
  wire();
  showLoginMessage();

  session = await sessionRequest;
  render();
};

void boot();
