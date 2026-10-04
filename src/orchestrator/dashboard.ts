export const renderLogin = (nonce: string) => `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Muse Control</title>
  <style nonce="${nonce}">
    body{font-family:system-ui,sans-serif;background:#111318;color:#eef1f7;display:grid;place-items:center;min-height:100vh;margin:0}
    main{width:min(520px,calc(100% - 40px));background:#1b1f28;border:1px solid #303746;border-radius:16px;padding:32px}
    h1{margin-top:0}p{color:#b8c0d0;line-height:1.5}a{display:inline-block;background:#5865f2;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700}
  </style>
</head>
<body><main><h1>Muse Control</h1><p>Accedi con Discord. La dashboard mostra solo i server che puoi amministrare.</p><a href="/auth/login">Accedi con Discord</a></main></body>
</html>`;

export const renderDashboard = (nonce: string) => `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Muse Control</title>
  <style nonce="${nonce}">
    :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0d1016;color:#eef2f8}
    *{box-sizing:border-box}body{margin:0;background:#0d1016}header{position:sticky;top:0;z-index:4;background:#121722;border-bottom:1px solid #283143;padding:14px 22px;display:flex;gap:16px;align-items:center}
    header strong{font-size:18px}.spacer{flex:1}button,a.button{border:0;border-radius:8px;padding:9px 12px;background:#5865f2;color:#fff;font-weight:650;cursor:pointer;text-decoration:none}
    button.secondary{background:#283143}button.danger{background:#b83b47}button:disabled{opacity:.45;cursor:not-allowed}
    main{max-width:1440px;margin:0 auto;padding:22px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}.card{background:#151b26;border:1px solid #283143;border-radius:12px;padding:16px;margin-bottom:16px}
    h2,h3{margin:0 0 12px}label{display:block;font-size:12px;color:#adb8c9;margin-bottom:5px}input,select{width:100%;background:#0d1119;color:#eef2f8;border:1px solid #364158;border-radius:7px;padding:8px}
    .settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.muted{color:#9da9bb}.ok{color:#73d69a}.bad{color:#ff8791}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 7px;border-bottom:1px solid #283143;font-size:13px}th{color:#aeb9c8}td input[type=checkbox]{width:auto}
    .pill{display:inline-block;padding:3px 7px;border-radius:999px;background:#273044;font-size:12px}.group-card{border:1px solid #2e394d;border-radius:10px;padding:12px;margin-top:10px}
    #notice{position:fixed;right:18px;bottom:18px;max-width:520px;background:#20283a;border:1px solid #3d4a64;border-radius:9px;padding:12px;display:none;z-index:8}
    .toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.toolbar>div{min-width:180px;flex:1}.wide{overflow:auto}
  </style>
</head>
<body>
<header>
  <strong>Muse Control</strong>
  <select id="guild" style="max-width:360px"></select>
  <span id="who" class="muted"></span>
  <span class="spacer"></span>
  <a class="button" href="/auth/logout">Esci</a>
</header>
<main>
  <div id="summary" class="card"></div>

  <section class="card">
    <h2>Configurazione server</h2>
    <p class="muted">Questi valori vengono ereditati da tutti i worker. Un gruppo o un singolo worker può sovrascriverli.</p>
    <div id="guild-settings" class="settings"></div>
    <div class="toolbar" style="margin-top:12px">
      <div><label>Player simultanei massimi</label><input id="max-players" type="number" min="1" max="5"></div>
    </div>
    <div class="actions"><button id="save-guild">Salva server</button><button class="secondary" id="sync">Sincronizza tutti</button></div>
  </section>

  <section class="card">
    <h2>Worker</h2>
    <p class="muted">Seleziona uno, alcuni o tutti i bot e applica la stessa modifica.</p>
    <div class="wide"><table><thead><tr><th></th><th>Bot</th><th>Stato</th><th>Server</th><th>Vocale</th><th>Gruppo</th><th>Priorità</th></tr></thead><tbody id="workers"></tbody></table></div>
    <div class="toolbar" style="margin-top:14px">
      <div><label>Gruppo per selezionati</label><select id="bulk-group"></select></div>
      <div><label>Abilitazione</label><select id="bulk-enabled"><option value="">Non cambiare</option><option value="true">Abilita</option><option value="false">Disabilita</option></select></div>
      <div><label>Priorità pool</label><input id="bulk-order" type="number" min="1" max="1000" placeholder="Non cambiare"></div>
    </div>
    <h3 style="margin-top:16px">Override selezionati</h3>
    <div id="bulk-settings" class="settings"></div>
    <div class="actions">
      <button id="apply-bulk">Applica ai selezionati</button>
      <button id="clear-bulk" class="secondary">Rimuovi override selezionati</button>
    </div>
  </section>

  <section class="card">
    <h2>Gruppi del server</h2>
    <div class="toolbar"><div><label>Nuovo gruppo</label><input id="new-group-name" maxlength="64" placeholder="es. Principali"></div><div style="flex:0"><button id="create-group">Crea gruppo</button></div></div>
    <div id="groups"></div>
  </section>
</main>
<div id="notice"></div>
<script nonce="${nonce}">
'use strict';
const settingDefs = [
  ['playlistLimit','Playlist limit','number',1,1000],
  ['secondsToWaitAfterQueueEmpties','Attesa coda vuota (s)','number',0,86400],
  ['leaveIfNoListeners','Esci senza ascoltatori','boolean'],
  ['queueAddResponseEphemeral','Risposta /play privata','boolean'],
  ['autoAnnounceNextSong','Annuncia prossimo brano','boolean'],
  ['defaultVolume','Volume predefinito','number',0,100],
  ['defaultQueuePageSize','Righe pagina coda','number',1,30],
  ['turnDownVolumeWhenPeopleSpeak','Riduci volume quando parlano','boolean'],
  ['turnDownVolumeWhenPeopleSpeakTarget','Volume durante voce','number',0,100],
  ['enableSponsorBlock','SponsorBlock','boolean']
];
let me=null, state=null, pool=null;

function notice(message, bad){
  const el=document.getElementById('notice'); el.textContent=message; el.className=bad?'bad':'ok'; el.style.display='block';
  setTimeout(()=>{el.style.display='none'},4500);
}
async function api(path, options){
  const opts=Object.assign({},options||{}); opts.headers=Object.assign({},opts.headers||{});
  if(opts.body && typeof opts.body!=='string'){opts.headers['content-type']='application/json';opts.body=JSON.stringify(opts.body)}
  if(me && opts.method && opts.method!=='GET'){opts.headers['x-csrf-token']=me.csrfToken}
  const response=await fetch(path,opts);
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||('HTTP '+response.status));
  return data;
}
function settingsForm(containerId, values, mode){
  const root=document.getElementById(containerId); root.innerHTML='';
  settingDefs.forEach(def=>{
    const key=def[0], label=def[1], type=def[2]; const wrap=document.createElement('div');
    const lab=document.createElement('label'); lab.textContent=label; wrap.appendChild(lab);
    let input;
    if(type==='boolean'){
      input=document.createElement('select');
      if(mode!=='effective'){input.append(new Option(mode==='bulk'?'Non cambiare':'Eredita',''))}
      input.append(new Option('Sì','true'));input.append(new Option('No','false'));
      if(Object.prototype.hasOwnProperty.call(values||{},key)) input.value=String(values[key]);
    }else{
      input=document.createElement('input');input.type='number';input.min=String(def[3]);input.max=String(def[4]);
      input.placeholder=mode==='bulk'?'Non cambiare':'Eredita';
      if(Object.prototype.hasOwnProperty.call(values||{},key)) input.value=String(values[key]);
    }
    input.dataset.key=key; wrap.appendChild(input); root.appendChild(wrap);
  });
}
function readSettings(containerId, includeNull){
  const result={}; document.querySelectorAll('#'+containerId+' [data-key]').forEach(input=>{
    const key=input.dataset.key; const value=input.value;
    if(value===''){if(includeNull)result[key]=null;return}
    const def=settingDefs.find(item=>item[0]===key); result[key]=def[2]==='boolean'?value==='true':Number(value);
  }); return result;
}
function groupOptions(select, current, includeNoChange){
  select.innerHTML='';
  if(includeNoChange) select.append(new Option('Non cambiare','__nochange__'));
  select.append(new Option('Nessun gruppo',''));
  (state.groups||[]).forEach(group=>select.append(new Option(group.name,group.id)));
  if(typeof current==='string'||current===null) select.value=current||'';
}
function selectedWorkers(){return [...document.querySelectorAll('#workers input[type=checkbox]:checked')].map(el=>el.value)}
function renderWorkers(){
  const body=document.getElementById('workers'); body.innerHTML='';
  state.workers.forEach(worker=>{
    const live=pool.workers.find(item=>item.id===worker.id)||{}; const tr=document.createElement('tr');
    const check=document.createElement('input');check.type='checkbox';check.value=worker.id;
    const td0=document.createElement('td');td0.appendChild(check);tr.appendChild(td0);
    const values=[
      worker.label,
      live.online?'Online':'Offline',
      live.inGuild?'Presente':'Non invitato',
      live.player&&live.player.voiceChannelId?live.player.voiceChannelId:'-',
      (state.groups.find(g=>g.id===worker.groupId)||{}).name||'-',
      String(worker.preferredOrder)
    ];
    values.forEach((value,index)=>{const td=document.createElement('td');td.textContent=value;if(index===1)td.className=live.online?'ok':'bad';tr.appendChild(td)});
    body.appendChild(tr);
  });
}
function renderGroups(){
  const root=document.getElementById('groups');root.innerHTML='';
  state.groups.forEach((group,index)=>{
    const card=document.createElement('div');card.className='group-card';card.innerHTML='<div class="toolbar"><div><label>Nome</label><input class="group-name"></div></div><div class="settings group-settings"></div><div class="actions"><button class="save-group">Salva gruppo</button><button class="danger delete-group">Elimina</button></div>';
    card.querySelector('.group-name').value=group.name; const settingsId='group-settings-'+index;card.querySelector('.group-settings').id=settingsId;root.appendChild(card);settingsForm(settingsId,group.settings,'inherit');
    card.querySelector('.save-group').onclick=async()=>{try{await api('/api/guilds/'+state.guild.guildId+'/groups/'+group.id,{method:'PATCH',body:{name:card.querySelector('.group-name').value,settings:readSettings(settingsId,true)}});await loadGuild();notice('Gruppo aggiornato')}catch(e){notice(e.message,true)}};
    card.querySelector('.delete-group').onclick=async()=>{if(!confirm('Eliminare il gruppo? I worker torneranno senza gruppo.'))return;try{await api('/api/guilds/'+state.guild.guildId+'/groups/'+group.id,{method:'DELETE'});await loadGuild();notice('Gruppo eliminato')}catch(e){notice(e.message,true)}};
  });
}
function render(){
  document.getElementById('summary').innerHTML='<strong>'+state.guild.name+'</strong><br><span class="muted">'+pool.workers.filter(w=>w.online).length+'/'+pool.workers.length+' worker online · '+pool.workers.filter(w=>w.player&&w.player.voiceChannelId).length+'/'+state.guild.maxConcurrentPlayers+' player in uso</span>';
  document.getElementById('max-players').value=state.guild.maxConcurrentPlayers;
  settingsForm('guild-settings',state.guild.settings,'inherit');settingsForm('bulk-settings',{},'bulk');
  groupOptions(document.getElementById('bulk-group'),undefined,true);renderWorkers();renderGroups();
}
async function loadGuild(){
  const guildId=document.getElementById('guild').value;if(!guildId)return;
  const data=await api('/api/guilds/'+guildId);state=data.state;pool=data.pool;render();
}
async function bootstrap(){
  me=await api('/api/me');document.getElementById('who').textContent=me.user.displayName;
  const select=document.getElementById('guild');me.guilds.forEach(g=>select.append(new Option(g.name,g.id)));select.onchange=()=>loadGuild().catch(e=>notice(e.message,true));
  if(me.guilds.length)await loadGuild();else document.getElementById('summary').textContent='Nessun server amministrabile trovato.';
}
document.getElementById('save-guild').onclick=async()=>{try{await api('/api/guilds/'+state.guild.guildId,{method:'PATCH',body:{settings:readSettings('guild-settings',true),maxConcurrentPlayers:Number(document.getElementById('max-players').value)}});await loadGuild();notice('Configurazione server salvata')}catch(e){notice(e.message,true)}};
document.getElementById('sync').onclick=async()=>{try{const r=await api('/api/guilds/'+state.guild.guildId+'/sync',{method:'POST',body:{}});await loadGuild();notice('Sincronizzazione completata: '+r.results.filter(x=>x.ok).length+'/'+r.results.length)}catch(e){notice(e.message,true)}};
document.getElementById('create-group').onclick=async()=>{try{await api('/api/guilds/'+state.guild.guildId+'/groups',{method:'POST',body:{name:document.getElementById('new-group-name').value}});document.getElementById('new-group-name').value='';await loadGuild();notice('Gruppo creato')}catch(e){notice(e.message,true)}};
document.getElementById('apply-bulk').onclick=async()=>{try{const ids=selectedWorkers();if(!ids.length)throw new Error('Seleziona almeno un worker');const group=document.getElementById('bulk-group').value;const enabled=document.getElementById('bulk-enabled').value;const order=document.getElementById('bulk-order').value;const input={settings:readSettings('bulk-settings',false)};if(group!=='__nochange__')input.groupId=group||null;if(enabled!=='')input.enabled=enabled==='true';if(order!=='')input.preferredOrder=Number(order);await api('/api/guilds/'+state.guild.guildId+'/workers/bulk',{method:'PATCH',body:{workerIds:ids,input}});await loadGuild();notice('Worker aggiornati')}catch(e){notice(e.message,true)}};
document.getElementById('clear-bulk').onclick=async()=>{try{const ids=selectedWorkers();if(!ids.length)throw new Error('Seleziona almeno un worker');const settings={};settingDefs.forEach(def=>settings[def[0]]=null);await api('/api/guilds/'+state.guild.guildId+'/workers/bulk',{method:'PATCH',body:{workerIds:ids,input:{settings}}});await loadGuild();notice('Override rimossi')}catch(e){notice(e.message,true)}};
bootstrap().catch(e=>notice(e.message,true));
</script>
</body>
</html>`;
