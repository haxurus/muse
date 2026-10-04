// Guild-specific routing editor. No bot/control credentials are exposed here.
(() => {
  let active = null;
  let generation = 0;
  const panel = document.createElement('section');
  panel.className = 'panel';
  const heading = document.createElement('h2');
  heading.textContent = 'Assegnazione automatica dei player';
  const help = document.createElement('p');
  help.className = 'muted';
  help.textContent = 'Precedenza: vocale > categoria > gruppo predefinito. Le regole valgono per le nuove sessioni, senza spostare quelle attive.';
  const form = document.createElement('form');
  const list = document.createElement('div');
  list.className = 'group-list';
  const message = document.createElement('p');
  message.className = 'muted';
  message.setAttribute('role', 'status');
  panel.append(heading, help, form, list, message);
  document.getElementById('guild-content').append(panel);

  const node = (tag, text, className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const selectGroups = (groups, selected, allowAll) => {
    const select = document.createElement('select');
    select.className = 'text-input';
    if (allowAll) {
      const option = node('option', 'Tutti i bot disponibili');
      option.value = '';
      select.append(option);
    }
    for (const group of groups) {
      const option = node('option', group.name);
      option.value = group.id;
      select.append(option);
    }
    select.value = selected ?? '';
    return select;
  };
  const field = (name, control) => {
    const label = node('label', name, 'setting-copy');
    label.append(control);
    return label;
  };
  const request = async (context, method, body) => {
    const response = await fetch(`/api/guilds/${encodeURIComponent(context.guildId)}/routing`, {
      method, credentials: 'same-origin',
      headers: {'content-type': 'application/json', 'x-csrf-token': context.csrfToken},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Configurazione non disponibile.');
    return result.routing;
  };
  const save = async patch => {
    const context = active;
    if (!context || context.saving) return;
    context.saving = true;
    message.textContent = 'Salvataggio...';
    try {
      const routing = await request(context, 'PATCH', patch);
      if (active !== context) return;
      context.routing = routing;
      render();
      message.textContent = 'Regole salvate per questo server.';
      message.className = 'success';
    } catch (error) {
      if (active === context) {
        message.textContent = error.message;
        message.className = 'error';
      }
    } finally {
      context.saving = false;
    }
  };
  const render = () => {
    form.replaceChildren();
    list.replaceChildren();
    const {routing, groups} = active;
    const defaultGroup = selectGroups(groups, routing.defaultGroupId, true);
    const saveDefault = node('button', 'Salva gruppo predefinito', 'button primary');
    saveDefault.type = 'button';
    saveDefault.addEventListener('click', () => void save({defaultGroupId: defaultGroup.value || null}));
    const defaultRow = node('div', '', 'group-editor');
    defaultRow.append(field('Gruppo predefinito', defaultGroup), saveDefault);
    form.append(defaultRow);

    const kind = node('select', '', 'text-input');
    for (const [value, text] of [['channelGroups', 'Canale vocale'], ['categoryGroups', 'Categoria']]) {
      const option = node('option', text);
      option.value = value;
      kind.append(option);
    }
    const id = node('input', '', 'text-input');
    id.type = 'text';
    id.inputMode = 'numeric';
    id.placeholder = 'ID Discord';
    id.maxLength = 32;
    const group = selectGroups(groups, groups[0]?.id, false);
    const add = node('button', 'Aggiungi associazione', 'button ghost');
    add.type = 'button';
    add.disabled = groups.length === 0;
    add.addEventListener('click', () => {
      if (!/^\d{10,32}$/.test(id.value.trim())) {
        message.textContent = 'Inserisci un ID Discord valido.';
        message.className = 'error';
        return;
      }
      void save({[kind.value]: {...active.routing[kind.value], [id.value.trim()]: group.value}});
    });
    const row = node('div', '', 'group-editor');
    row.append(field('Tipo', kind), field('ID vocale o categoria', id), field('Gruppo', group), add);
    form.append(row);
    for (const key of ['channelGroups', 'categoryGroups']) {
      for (const [channelId, groupId] of Object.entries(routing[key])) {
        const name = groups.find(candidate => candidate.id === groupId)?.name || 'Gruppo non disponibile';
        const card = node('div', '', 'group-card');
        card.append(node('span', `${key === 'channelGroups' ? 'Vocale' : 'Categoria'} ${channelId} -> ${name}`));
        const remove = node('button', 'Rimuovi', 'button danger');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          const next = Object.fromEntries(Object.entries(active.routing[key]).filter(([value]) => value !== channelId));
          void save({[key]: next});
        });
        card.append(remove);
        list.append(card);
      }
    }
  };
  form.addEventListener('submit', event => event.preventDefault());
  window.addEventListener('muse:guild-loading', () => {
    generation++;
    active = null;
    form.replaceChildren();
    list.replaceChildren();
    message.className = 'muted';
    message.textContent = 'Caricamento delle regole...';
  });
  window.addEventListener('muse:guild', async event => {
    const revision = ++generation;
    const context = {...event.detail, saving: false};
    active = null;
    form.replaceChildren();
    list.replaceChildren();
    try {
      context.routing = await request(context, 'GET');
      if (revision !== generation) return;
      active = context;
      render();
      message.textContent = 'I gruppi esauriti non usano automaticamente bot di altri gruppi.';
    } catch (error) {
      if (revision === generation) {
        message.textContent = error.message;
        message.className = 'error';
      }
    }
  });
  const selector = document.getElementById('pool-guild');
  let browsing = 0;
  const boot = async () => {
    const response = await fetch('/api/session', {credentials: 'same-origin'});
    if (response.status === 401) {
      window.location.assign('/auth/discord');
      return;
    }
    if (!response.ok) throw new Error('Sessione non disponibile.');
    const session = await response.json();
    for (const guild of session.guilds) {
      const option = node('option', guild.name);
      option.value = guild.id;
      selector.append(option);
    }
    const selectGuild = async () => {
      const version = ++browsing;
      const guildId = selector.value;
      window.dispatchEvent(new Event('muse:guild-loading'));
      if (!guildId) return;
      try {
        const detailsResponse = await fetch(`/api/guilds/${encodeURIComponent(guildId)}`, {credentials: 'same-origin'});
        if (!detailsResponse.ok) throw new Error('Server non disponibile o permessi insufficienti.');
        const details = await detailsResponse.json();
        if (version !== browsing) return;
        window.dispatchEvent(new CustomEvent('muse:guild', {
          detail: {guildId, groups: details.groups || [], csrfToken: session.csrfToken},
        }));
      } catch (error) {
        if (version === browsing) {
          message.textContent = error.message;
          message.className = 'error';
        }
      }
    };
    selector.disabled = false;
    selector.addEventListener('change', () => void selectGuild());
    if (session.guilds.length === 0) {
      message.textContent = 'Nessun server amministrabile con Muse disponibile.';
    } else {
      await selectGuild();
    }
  };
  void boot().catch(error => {
    message.textContent = error.message;
    message.className = 'error';
  });
})();
