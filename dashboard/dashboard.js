const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const guildList = document.getElementById('guild-list');
const guildContent = document.getElementById('guild-content');
const emptyState = document.getElementById('empty-state');
const workerGrid = document.getElementById('worker-grid');
const settingsForm = document.getElementById('settings-form');
const selectionSummary = document.getElementById('selection-summary');
const formMessage = document.getElementById('form-message');
const applyButton = document.getElementById('apply-button');
const statusPill = document.getElementById('status-pill');
const guildQuota = document.getElementById('guild-quota');
const groupsContainer = document.getElementById('groups-container');
const poolMessage = document.getElementById('pool-message');
const poolUsageLabel = document.getElementById('pool-usage-label');
const savePoolButton = document.getElementById('save-pool');
const addGroupButton = document.getElementById('add-group');

let session = null;
let selectedGuildId = null;
let guildDetails = null;
const selectedWorkers = new Set();
let poolDraftGroups = [];

const SETTINGS = [
  {key: 'defaultVolume', label: 'Volume predefinito', hint: '0-100', type: 'number', min: 0, max: 100},
  {key: 'playlistLimit', label: 'Limite playlist', hint: '1-500 tracce', type: 'number', min: 1, max: 500},
  {key: 'secondsToWaitAfterQueueEmpties', label: 'Auto-disconnect', hint: 'Secondi, 0 = mai', type: 'number', min: 0, max: 86400},
  {key: 'defaultQueuePageSize', label: 'Pagina coda', hint: '1-30 elementi', type: 'number', min: 1, max: 30},
  {key: 'leaveIfNoListeners', label: 'Esci senza listener', hint: 'Lascia la vocale se resta solo', type: 'boolean'},
  {key: 'queueAddResponseEphemeral', label: 'Risposta privata', hint: 'Conferma queue visibile solo al richiedente', type: 'boolean'},
  {key: 'autoAnnounceNextSong', label: 'Annuncia prossimo brano', hint: 'Messaggio automatico alla traccia successiva', type: 'boolean'},
  {key: 'turnDownVolumeWhenPeopleSpeak', label: 'Riduci volume al parlato', hint: 'Abbassa la musica quando qualcuno parla', type: 'boolean'},
  {key: 'turnDownVolumeWhenPeopleSpeakTarget', label: 'Volume durante parlato', hint: '0-100', type: 'number', min: 0, max: 100},
];

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
  });

  if (response.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Richiesta non riuscita');
  }

  return body;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const showLogin = () => {
  loginView.hidden = false;
  appView.hidden = true;
};

const showApp = () => {
  loginView.hidden = true;
  appView.hidden = false;
};

const guildButton = guild => {
  const button = el('button', 'guild-button');
  button.type = 'button';
  button.dataset.guildId = guild.id;

  let icon;
  if (guild.iconUrl) {
    icon = el('img', 'guild-icon');
    icon.src = guild.iconUrl;
    icon.alt = '';
  } else {
    icon = el('div', 'guild-fallback', guild.name.slice(0, 1).toUpperCase());
  }

  const copy = el('div', 'guild-copy');
  copy.append(
    el('strong', '', guild.name),
    el('span', '', guild.owner ? 'Proprietario' : 'Amministratore'),
  );

  button.append(icon, copy, el('span', 'count-badge', String(guild.availableWorkers)));
  button.addEventListener('click', () => selectGuild(guild.id));
  return button;
};

const renderGuilds = () => {
  guildList.replaceChildren();

  if (session.guilds.length === 0) {
    guildList.append(el('p', 'muted', 'Nessun server amministrabile con Muse disponibile.'));
    return;
  }

  for (const guild of session.guilds) {
    guildList.append(guildButton(guild));
  }
};

const settingControl = definition => {
  const row = el('div', 'setting-row');
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'setting-enabled';
  enabled.dataset.key = definition.key;

  const copy = el('div', 'setting-copy');
  copy.append(el('strong', '', definition.label), el('span', '', definition.hint));

  let input;
  if (definition.type === 'boolean') {
    input = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Seleziona...';
    const yes = document.createElement('option');
    yes.value = 'true';
    yes.textContent = 'Sì';
    const no = document.createElement('option');
    no.value = 'false';
    no.textContent = 'No';
    input.append(empty, yes, no);
  } else {
    input = document.createElement('input');
    input.type = 'number';
    input.min = String(definition.min);
    input.max = String(definition.max);
    input.step = '1';
  }

  input.dataset.key = definition.key;
  input.className = 'setting-input';
  input.disabled = true;

  enabled.addEventListener('change', () => {
    input.disabled = !enabled.checked;
  });

  row.append(enabled, copy, input);
  return row;
};

const renderSettingsForm = () => {
  settingsForm.replaceChildren();
  for (const definition of SETTINGS) {
    settingsForm.append(settingControl(definition));
  }
};

const workerDisplayName = workerId => {
  const worker = guildDetails?.workers.find(candidate => candidate.workerId === workerId);
  return worker?.value?.status?.bot?.username ?? workerId;
};

const makeCheckChip = ({value, label, checked, onChange}) => {
  const chip = el('label', 'check-chip');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = value;
  checkbox.checked = checked;
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  chip.append(checkbox, document.createTextNode(label));
  return chip;
};

const renderPoolGroups = () => {
  groupsContainer.replaceChildren();

  if (poolDraftGroups.length === 0) {
    groupsContainer.append(el(
      'div',
      'group-empty',
      'Nessun gruppo: tutte le vocali useranno automaticamente l’intero pool disponibile.',
    ));
    return;
  }

  for (const group of poolDraftGroups) {
    const card = el('div', 'group-card');
    card.dataset.groupId = group.id;

    const head = el('div', 'group-head');

    const nameField = el('label', 'group-field');
    nameField.append(el('span', '', 'Nome gruppo'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 48;
    nameInput.value = group.name;
    nameInput.addEventListener('input', () => {
      group.name = nameInput.value;
    });
    nameField.append(nameInput);

    const quotaField = el('label', 'group-field');
    quotaField.append(el('span', '', 'Quota gruppo'));
    const quotaInput = document.createElement('input');
    quotaInput.type = 'number';
    quotaInput.min = '0';
    quotaInput.max = String(group.workerIds.length);
    quotaInput.step = '1';
    quotaInput.value = String(Math.min(group.maxConcurrentPlayers, group.workerIds.length));
    quotaInput.addEventListener('input', () => {
      group.maxConcurrentPlayers = Number(quotaInput.value);
    });
    quotaField.append(quotaInput);

    const defaultLabel = el('label', 'group-default');
    const defaultRadio = document.createElement('input');
    defaultRadio.type = 'radio';
    defaultRadio.name = 'default-pool-group';
    defaultRadio.checked = group.isDefault;
    defaultRadio.addEventListener('change', () => {
      if (!defaultRadio.checked) return;
      for (const candidate of poolDraftGroups) {
        candidate.isDefault = candidate.id === group.id;
      }
    });
    defaultLabel.append(defaultRadio, document.createTextNode('Predefinito'));

    const remove = el('button', 'button ghost', 'Rimuovi');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      poolDraftGroups = poolDraftGroups.filter(candidate => candidate.id !== group.id);
      if (poolDraftGroups.length > 0 && !poolDraftGroups.some(candidate => candidate.isDefault)) {
        poolDraftGroups[0].isDefault = true;
      }
      renderPoolGroups();
    });

    head.append(nameField, quotaField, defaultLabel, remove);
    card.append(head);

    const workerSection = el('div', 'group-section');
    workerSection.append(el('span', 'group-section-title', 'WORKER DEL GRUPPO'));
    const workerChecks = el('div', 'check-grid');

    for (const workerId of guildDetails.pool.availableWorkerIds) {
      workerChecks.append(makeCheckChip({
        value: workerId,
        label: workerDisplayName(workerId),
        checked: group.workerIds.includes(workerId),
        onChange: checked => {
          if (checked) {
            for (const candidate of poolDraftGroups) {
              if (candidate.id !== group.id) {
                candidate.workerIds = candidate.workerIds.filter(id => id !== workerId);
                candidate.maxConcurrentPlayers = Math.min(candidate.maxConcurrentPlayers, candidate.workerIds.length);
              }
            }
            if (!group.workerIds.includes(workerId)) group.workerIds.push(workerId);
          } else {
            group.workerIds = group.workerIds.filter(id => id !== workerId);
          }

          group.maxConcurrentPlayers = Math.min(group.maxConcurrentPlayers, group.workerIds.length);
          renderPoolGroups();
        },
      }));
    }

    workerSection.append(workerChecks);
    card.append(workerSection);

    const channelSection = el('div', 'group-section');
    channelSection.append(el('span', 'group-section-title', 'VOCALI RISERVATE AL GRUPPO'));
    const channelChecks = el('div', 'check-grid');

    if (guildDetails.pool.voiceChannels.length === 0) {
      channelChecks.append(el('span', 'muted', 'Nessuna vocale disponibile.'));
    }

    for (const channel of guildDetails.pool.voiceChannels) {
      channelChecks.append(makeCheckChip({
        value: channel.id,
        label: channel.name,
        checked: group.voiceChannelIds.includes(channel.id),
        onChange: checked => {
          if (checked) {
            for (const candidate of poolDraftGroups) {
              if (candidate.id !== group.id) {
                candidate.voiceChannelIds = candidate.voiceChannelIds.filter(id => id !== channel.id);
              }
            }
            if (!group.voiceChannelIds.includes(channel.id)) group.voiceChannelIds.push(channel.id);
          } else {
            group.voiceChannelIds = group.voiceChannelIds.filter(id => id !== channel.id);
          }

          renderPoolGroups();
        },
      }));
    }

    channelSection.append(channelChecks);
    card.append(channelSection);
    groupsContainer.append(card);
  }
};

const renderPoolConfig = () => {
  const {config, availableWorkerIds} = guildDetails.pool;
  guildQuota.min = '0';
  guildQuota.max = String(availableWorkerIds.length);
  guildQuota.value = String(Math.min(config.maxConcurrentPlayers, availableWorkerIds.length));
  poolDraftGroups = config.groups.map(group => ({
    ...group,
    workerIds: [...group.workerIds],
    voiceChannelIds: [...group.voiceChannelIds],
  }));

  const activePlayers = guildDetails.workers.filter(worker => (
    worker.ok
    && worker.value?.status?.players?.some(player => (
      player.guildId === selectedGuildId && (player.connected || player.hasCurrent)
    ))
  )).length;
  poolUsageLabel.textContent = activePlayers + '/' + config.maxConcurrentPlayers + ' player occupati';

  renderPoolGroups();
};

const nextGroupId = () => {
  const used = new Set(poolDraftGroups.map(group => group.id));
  for (let index = 1; index <= 99; index++) {
    const id = 'group-' + index;
    if (!used.has(id)) return id;
  }
  throw new Error('Troppi gruppi configurati.');
};

const addPoolGroup = () => {
  const assigned = new Set(poolDraftGroups.flatMap(group => group.workerIds));
  const available = guildDetails.pool.availableWorkerIds.find(workerId => !assigned.has(workerId));
  if (!available) {
    poolMessage.textContent = 'Tutti i worker appartengono già a un gruppo.';
    poolMessage.className = 'error';
    return;
  }

  poolDraftGroups.push({
    id: nextGroupId(),
    name: 'Nuovo gruppo',
    workerIds: [available],
    voiceChannelIds: [],
    maxConcurrentPlayers: 1,
    isDefault: poolDraftGroups.length === 0,
  });
  poolMessage.textContent = '';
  poolMessage.className = 'muted';
  renderPoolGroups();
};

const savePool = async () => {
  if (!selectedGuildId) return;

  const maxConcurrentPlayers = Number(guildQuota.value);
  if (!Number.isSafeInteger(maxConcurrentPlayers)
    || maxConcurrentPlayers < 0
    || maxConcurrentPlayers > guildDetails.pool.availableWorkerIds.length) {
    poolMessage.textContent = 'Quota server non valida.';
    poolMessage.className = 'error';
    return;
  }

  for (const group of poolDraftGroups) {
    group.name = group.name.trim();
    if (!group.name || group.workerIds.length === 0) {
      poolMessage.textContent = 'Ogni gruppo deve avere un nome e almeno un worker.';
      poolMessage.className = 'error';
      return;
    }

    if (!Number.isSafeInteger(group.maxConcurrentPlayers)
      || group.maxConcurrentPlayers < 0
      || group.maxConcurrentPlayers > group.workerIds.length) {
      poolMessage.textContent = 'Quota non valida nel gruppo ' + group.name + '.';
      poolMessage.className = 'error';
      return;
    }
  }

  if (poolDraftGroups.length > 0
    && poolDraftGroups.filter(group => group.isDefault).length !== 1) {
    poolMessage.textContent = 'Deve esserci esattamente un gruppo predefinito.';
    poolMessage.className = 'error';
    return;
  }

  savePoolButton.disabled = true;
  poolMessage.textContent = 'Salvataggio...';
  poolMessage.className = 'muted';

  try {
    await api('/api/guilds/' + encodeURIComponent(selectedGuildId) + '/pool', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        maxConcurrentPlayers,
        groups: poolDraftGroups,
      }),
    });

    await selectGuild(selectedGuildId);
    poolMessage.textContent = 'Pool aggiornato.';
    poolMessage.className = 'success';
  } catch (error) {
    poolMessage.textContent = error.message;
    poolMessage.className = 'error';
  } finally {
    savePoolButton.disabled = false;
  }
};

const selectedWorkerResults = () => {
  if (!guildDetails) return [];
  return guildDetails.workers.filter(worker => worker.ok && selectedWorkers.has(worker.workerId));
};

const syncSuggestedValues = () => {
  const workers = selectedWorkerResults();
  for (const definition of SETTINGS) {
    const input = settingsForm.querySelector(`.setting-input[data-key="${definition.key}"]`);
    if (!input || workers.length === 0) continue;

    const values = workers.map(worker => worker.value?.settings?.[definition.key]);
    const first = values[0];
    const allSame = values.every(value => value === first);

    if (!allSame || first === undefined || first === null) {
      input.value = '';
      continue;
    }

    input.value = String(first);
  }
};

const updateSelectionSummary = () => {
  const count = selectedWorkers.size;
  selectionSummary.textContent = `${count} worker selezionat${count === 1 ? 'o' : 'i'}`;
  applyButton.disabled = count === 0;

  for (const card of workerGrid.querySelectorAll('.worker-card')) {
    const checkbox = card.querySelector('input[type="checkbox"]');
    const selected = checkbox.checked;
    card.classList.toggle('selected', selected);
  }

  syncSuggestedValues();
};

const renderWorkers = () => {
  workerGrid.replaceChildren();
  selectedWorkers.clear();

  for (const worker of guildDetails.workers) {
    if (!worker.ok) continue;

    const card = el('label', 'worker-card');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = worker.workerId;

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedWorkers.add(worker.workerId);
      else selectedWorkers.delete(worker.workerId);
      updateSelectionSummary();
    });

    const group = guildDetails.pool.config.groups.find(candidate => candidate.workerIds.includes(worker.workerId));

    card.append(
      checkbox,
      el('span', 'worker-status', 'Online'),
      el('h3', '', worker.value?.status?.bot?.username ?? worker.workerId),
      el(
        'div',
        'worker-meta',
        (group ? group.name + ' · ' : '')
          + 'Volume '
          + (worker.value?.settings?.defaultVolume ?? '?')
          + '% · Playlist '
          + (worker.value?.settings?.playlistLimit ?? '?'),
      ),
    );

    workerGrid.append(card);
  }

  updateSelectionSummary();
};

const selectGuild = async guildId => {
  selectedGuildId = guildId;
  formMessage.textContent = '';
  statusPill.textContent = 'Caricamento';
  statusPill.className = 'status-pill';

  for (const button of guildList.querySelectorAll('.guild-button')) {
    button.classList.toggle('active', button.dataset.guildId === guildId);
  }

  try {
    guildDetails = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
    document.getElementById('page-title').textContent = guildDetails.guild.name;
    document.getElementById('page-subtitle').textContent = 'Configura uno, più o tutti i music bot disponibili in questo server.';
    emptyState.hidden = true;
    guildContent.hidden = false;
    renderPoolConfig();
    renderWorkers();
    statusPill.textContent = `${guildDetails.workers.filter(worker => worker.ok).length} worker online`;
    statusPill.className = 'status-pill ok';
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.className = 'error';
    statusPill.textContent = 'Errore';
  }
};

const collectSettings = () => {
  const settings = {};

  for (const definition of SETTINGS) {
    const enabled = settingsForm.querySelector(`.setting-enabled[data-key="${definition.key}"]`);
    const input = settingsForm.querySelector(`.setting-input[data-key="${definition.key}"]`);
    if (!enabled.checked) continue;

    if (definition.type === 'boolean') {
      if (input.value === '') {
        throw new Error(`Scegli un valore per ${definition.label}`);
      }

      settings[definition.key] = input.value === 'true';
      continue;
    }

    if (input.value === '') {
      throw new Error(`Inserisci un valore per ${definition.label}`);
    }

    settings[definition.key] = Number(input.value);
  }

  if (Object.keys(settings).length === 0) {
    throw new Error('Seleziona almeno un’impostazione da modificare.');
  }

  return settings;
};

const applySettings = async () => {
  if (!selectedGuildId || selectedWorkers.size === 0) return;

  formMessage.textContent = '';
  formMessage.className = 'muted';
  applyButton.disabled = true;

  try {
    const settings = collectSettings();
    const result = await api(`/api/guilds/${encodeURIComponent(selectedGuildId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        workerIds: [...selectedWorkers],
        settings,
      }),
    });

    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    await selectGuild(selectedGuildId);
    formMessage.textContent = failed === 0
      ? 'Configurazione applicata.'
      : `Configurazione applicata con ${failed} worker non aggiornati.`;
    formMessage.className = failed === 0 ? 'success' : 'error';
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.className = 'error';
  } finally {
    applyButton.disabled = selectedWorkers.size === 0;
  }
};

document.getElementById('select-all').addEventListener('click', () => {
  for (const checkbox of workerGrid.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = true;
    selectedWorkers.add(checkbox.value);
  }
  updateSelectionSummary();
});

document.getElementById('select-none').addEventListener('click', () => {
  for (const checkbox of workerGrid.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = false;
  }
  selectedWorkers.clear();
  updateSelectionSummary();
});

applyButton.addEventListener('click', applySettings);
addGroupButton.addEventListener('click', addPoolGroup);
savePoolButton.addEventListener('click', savePool);

document.getElementById('logout-button').addEventListener('click', async () => {
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'x-csrf-token': session.csrfToken,
      },
    });
  } finally {
    window.location.assign('/');
  }
});

const boot = async () => {
  renderSettingsForm();

  try {
    session = await api('/api/session');
  } catch (error) {
    if (error.message === 'AUTH_REQUIRED') {
      showLogin();
      return;
    }

    showLogin();
    return;
  }

  document.getElementById('user-name').textContent = session.user.displayName;
  document.getElementById('user-username').textContent = `@${session.user.username}`;

  const avatar = document.getElementById('user-avatar');
  if (session.user.avatarUrl) {
    avatar.src = session.user.avatarUrl;
  } else {
    avatar.hidden = true;
  }

  renderGuilds();
  showApp();
};

void boot();
