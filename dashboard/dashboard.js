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
const groupList = document.getElementById('group-list');
const groupName = document.getElementById('group-name');
const groupMessage = document.getElementById('group-message');
const groupEditorTitle = document.getElementById('group-editor-title');
const groupEditorHint = document.getElementById('group-editor-hint');
const groupOfflineRow = document.getElementById('group-offline-row');
const groupOfflineNote = document.getElementById('group-offline-note');
const saveGroupButton = document.getElementById('save-group');
const cancelGroupEditButton = document.getElementById('cancel-group-edit');
const dropOfflineMembersButton = document.getElementById('drop-offline-members');

let session = null;
let selectedGuildId = null;
let guildDetails = null;
const selectedWorkers = new Set();
let editingGroupId = null;
const preservedUnavailableWorkers = new Set();

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

    card.append(
      checkbox,
      el('span', 'worker-status', 'Online'),
      el('h3', '', worker.value?.status?.bot?.username ?? worker.workerId),
      el('div', 'worker-meta', `${worker.value?.status?.bot?.username ?? worker.workerId} · Volume ${worker.value?.settings?.defaultVolume ?? '?'}% · Playlist ${worker.value?.settings?.playlistLimit ?? '?'}`),
    );

    workerGrid.append(card);
  }

  updateSelectionSummary();
};

const availableWorkerIds = () => new Set(
  (guildDetails?.workers ?? [])
    .filter(worker => worker.ok)
    .map(worker => worker.workerId),
);

const setWorkerSelection = workerIds => {
  const available = availableWorkerIds();
  selectedWorkers.clear();

  for (const workerId of workerIds) {
    if (available.has(workerId)) {
      selectedWorkers.add(workerId);
    }
  }

  for (const checkbox of workerGrid.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = selectedWorkers.has(checkbox.value);
  }

  updateSelectionSummary();
};

const workerDisplayName = workerId => {
  const worker = guildDetails?.workers.find(candidate => candidate.workerId === workerId);
  return worker?.value?.status?.bot?.username ?? workerId;
};

const resetGroupEditor = () => {
  editingGroupId = null;
  preservedUnavailableWorkers.clear();
  groupName.value = '';
  groupEditorTitle.textContent = 'Nuovo gruppo';
  groupEditorHint.textContent = 'Seleziona i worker sopra, assegna un nome e salva.';
  saveGroupButton.textContent = 'Crea gruppo';
  cancelGroupEditButton.hidden = true;
  groupOfflineRow.hidden = true;
  groupOfflineNote.textContent = '';
};

const selectGroup = group => {
  const available = availableWorkerIds();
  const onlineMembers = group.workerIds.filter(workerId => available.has(workerId));
  const unavailableCount = group.workerIds.length - onlineMembers.length;

  setWorkerSelection(onlineMembers);
  groupMessage.textContent = unavailableCount === 0
    ? `Gruppo "${group.name}" selezionato.`
    : `Gruppo "${group.name}" selezionato: ${unavailableCount} membri non disponibili non sono stati selezionati.`;
  groupMessage.className = unavailableCount === 0 ? 'success' : 'muted';
};

const editGroup = group => {
  resetGroupEditor();
  editingGroupId = group.id;
  groupName.value = group.name;
  groupEditorTitle.textContent = `Modifica ${group.name}`;
  groupEditorHint.textContent = 'La selezione dei worker sopra rappresenta i membri disponibili del gruppo.';
  saveGroupButton.textContent = 'Salva modifiche';
  cancelGroupEditButton.hidden = false;

  const available = availableWorkerIds();
  for (const workerId of group.workerIds) {
    if (!available.has(workerId)) {
      preservedUnavailableWorkers.add(workerId);
    }
  }

  setWorkerSelection(group.workerIds);

  if (preservedUnavailableWorkers.size > 0) {
    groupOfflineRow.hidden = false;
    groupOfflineNote.textContent = `${preservedUnavailableWorkers.size} membri non disponibili verranno preservati.`;
  }
};

const deleteGroup = async group => {
  if (!window.confirm(`Eliminare il gruppo "${group.name}"? I bot e le loro configurazioni non verranno modificati.`)) {
    return;
  }

  try {
    await api(
      `/api/guilds/${encodeURIComponent(selectedGuildId)}/groups/${encodeURIComponent(group.id)}`,
      {
        method: 'DELETE',
        headers: {
          'x-csrf-token': session.csrfToken,
        },
      },
    );

    if (editingGroupId === group.id) {
      resetGroupEditor();
    }

    await selectGuild(selectedGuildId);
    groupMessage.textContent = 'Gruppo eliminato.';
    groupMessage.className = 'success';
  } catch (error) {
    groupMessage.textContent = error.message;
    groupMessage.className = 'error';
  }
};

const renderGroups = () => {
  groupList.replaceChildren();
  const groups = guildDetails?.groups ?? [];
  const available = availableWorkerIds();

  if (groups.length === 0) {
    groupList.append(el('div', 'group-empty', 'Nessun gruppo creato per questo server.'));
    return;
  }

  for (const group of groups) {
    const card = el('article', 'group-card');
    const copy = el('div', 'group-card-copy');
    const names = group.workerIds.map(workerDisplayName);
    const unavailable = group.workerIds.filter(workerId => !available.has(workerId));

    copy.append(
      el('strong', '', group.name),
      el('span', '', `${group.workerIds.length} bot · ${names.join(', ')}`),
    );

    if (unavailable.length > 0) {
      copy.append(el('span', 'group-warning', `${unavailable.length} non disponibili`));
    }

    const actions = el('div', 'group-actions');
    const selectButton = el('button', 'button ghost', 'Seleziona');
    selectButton.type = 'button';
    selectButton.addEventListener('click', () => selectGroup(group));

    const editButton = el('button', 'button ghost', 'Modifica');
    editButton.type = 'button';
    editButton.addEventListener('click', () => editGroup(group));

    const deleteButton = el('button', 'button danger', 'Elimina');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => {
      void deleteGroup(group);
    });

    actions.append(selectButton, editButton, deleteButton);
    card.append(copy, actions);
    groupList.append(card);
  }
};

const saveGroup = async () => {
  const name = groupName.value.trim();
  if (!name) {
    groupMessage.textContent = 'Inserisci un nome per il gruppo.';
    groupMessage.className = 'error';
    return;
  }

  const workerIds = [...new Set([
    ...selectedWorkers,
    ...preservedUnavailableWorkers,
  ])];

  if (workerIds.length === 0) {
    groupMessage.textContent = 'Seleziona almeno un worker.';
    groupMessage.className = 'error';
    return;
  }

  saveGroupButton.disabled = true;
  groupMessage.textContent = '';
  groupMessage.className = 'muted';

  try {
    const editing = editingGroupId !== null;
    const endpoint = editing
      ? `/api/guilds/${encodeURIComponent(selectedGuildId)}/groups/${encodeURIComponent(editingGroupId)}`
      : `/api/guilds/${encodeURIComponent(selectedGuildId)}/groups`;

    await api(endpoint, {
      method: editing ? 'PATCH' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        name,
        workerIds,
      }),
    });

    resetGroupEditor();
    await selectGuild(selectedGuildId);
    groupMessage.textContent = editing ? 'Gruppo aggiornato.' : 'Gruppo creato.';
    groupMessage.className = 'success';
  } catch (error) {
    groupMessage.textContent = error.message;
    groupMessage.className = 'error';
  } finally {
    saveGroupButton.disabled = false;
  }
};

const selectGuild = async guildId => {
  selectedGuildId = guildId;
  formMessage.textContent = '';
  groupMessage.textContent = '';
  resetGroupEditor();
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
    renderWorkers();
    renderGroups();
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
saveGroupButton.addEventListener('click', saveGroup);

cancelGroupEditButton.addEventListener('click', () => {
  resetGroupEditor();
});

dropOfflineMembersButton.addEventListener('click', () => {
  preservedUnavailableWorkers.clear();
  groupOfflineRow.hidden = true;
  groupOfflineNote.textContent = '';
});

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
