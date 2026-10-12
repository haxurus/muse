# Runbook operativo Muse (produzione)

Guida rapida per gestire e diagnosticare la flotta Muse sul VPS. È un indice operativo: i dettagli stanno nei documenti di riferimento, linkati in ogni sezione.

| Documento | Contenuto |
| --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Installazione VPS, segreti, firewall, flusso di deploy, backup, rollback, supply chain |
| [ORCHESTRATOR.md](ORCHESTRATOR.md) | API orchestratore/worker, gruppi, token di controllo |
| [SUPER_CONSOLE.md](SUPER_CONSOLE.md) | Blocklist, audit, canale di stato, piani e coupon, recapiti |
| [DASHBOARD.md](DASHBOARD.md) | OAuth Discord, sessioni, super admin, NPM |
| [BOT_ONE_PLAYBACK.md](BOT_ONE_PLAYBACK.md) … [BOT_FIVE_PLAYBACK.md](BOT_FIVE_PLAYBACK.md) | Overlay pilota di riproduzione orchestrata |

Tutti i comandi vanno eseguiti su VPS da una shell amministrativa (con `sudo`), salvo dove indicato. Non incollare mai il contenuto di `secrets/` in chat, issue o log.

## 0. Preparazione della shell

Comodità per i comandi Compose di questo runbook (stessa invocazione usata da `muse-deploy`):

```bash
MUSE=/srv/docker/muse
dc() { sudo docker compose --project-name muse --project-directory "$MUSE" \
  --env-file "$MUSE/.env" -f "$MUSE/docker-compose.yml" "$@"; }
```

Se `MUSE_COMPOSE_OVERLAYS` in `.env` non è vuoto, aggiungi a `dc` un `-f "$MUSE/overlays/docker-compose.<nome>.yml"` per ogni overlay attivo (es. `bot-one-playback`), altrimenti i comandi `up` ricreerebbero i servizi senza overlay.

I container si chiamano `muse-<servizio>-1`: `muse-dashboard-edge-1`, `muse-dashboard-1`, `muse-orchestrator-1`, `muse-pot-provider-1`, `muse-muse-01-1` … `muse-muse-05-1`.

## 1. Architettura in breve

Otto servizi Compose (progetto `muse`, file `deploy/docker-compose.prod.yml` installato come `/srv/docker/muse/docker-compose.yml`), tutti dalla stessa immagine `ghcr.io/haxurus/muse@sha256:…` tranne `pot-provider`:

| Servizio | Ruolo | Porta interna | Reti |
| --- | --- | --- | --- |
| `dashboard-edge` | Reverse proxy senza segreti, unico punto raggiunto da NPM (alias `muse-dashboard`) | 8080 | `muse-edge`, `dashboard-web` |
| `dashboard` | UI + OAuth Discord, sessioni in memoria | 3000 | `dashboard-web`, `dashboard-control`, `dashboard-egress` |
| `orchestrator` | API di controllo, stato centrale (gruppi, blocchi, piani…) | 3100 | `dashboard-control`, `control-01..05` |
| `pot-provider` | PO token YouTube (bgutil), non autenticato, nessuna porta pubblicata | 4416 | `egress`, `pot-01..05` (alias `muse-pot`) |
| `muse-01` … `muse-05` | Worker Discord (un bot ciascuno), API di controllo | 3101 | `egress`, `control-0N`, `pot-0N` |

Nessun servizio pubblica porte sull'host. Reti e bridge (dettagli in [DEPLOYMENT.md §14](DEPLOYMENT.md#14-network-model)):

| Rete | Bridge | Tipo |
| --- | --- | --- |
| `muse-edge` (esterna, creata da `ops/install-vps.sh`) | `muse-ed` | interna, solo NPM ↔ edge |
| `dashboard-web` / `dashboard-control` | `muse-dw` / `muse-dc` | interne |
| `control-01..05` | `muse-c01..05` | interne, orchestratore ↔ un worker |
| `pot-01..05` | `muse-p01..05` | interne, un worker ↔ pot-provider |
| `egress` / `dashboard-egress` | `muse-eg` / `muse-deg` | uscita Internet filtrata, ICC disabilitato |

Dati su disco (`/srv/docker/muse`):

```text
.env                       impostazioni non segrete (MUSE_IMAGE gestito da muse-deploy)
docker-compose.yml         Compose della release in esecuzione
config/workers.json        elenco worker per l'orchestratore (montato in /config, ro)
overlays/                  overlay pilota di riproduzione
secrets/                   segreti runtime (640 root:10001)
data/bot-0N/               volume /data del worker N: db.sqlite (Prisma/SQLite) e cache/ audio
data/orchestrator/         volume /state: groups.json, blocks.json, super-audit.json,
                           platform-settings.json, plans.json (+ copie .bak)
backups/                   archivi muse-*.tar.gz (DB worker + stato orchestratore)
.deploy-state/             current-image, previous-image, previous-backup, previous-config, last-backup
```

Lo stato dell'orchestratore è scritto in modo atomico (temp + fsync + rename) e prima di ogni scrittura il precedente stato valido viene salvato in `<file>.bak`. Deve girare **una sola** istanza di orchestratore per volume.

## 2. Deploy, stato, rollback

Riferimento completo: [DEPLOYMENT.md §10–13](DEPLOYMENT.md#10-first-manual-deploy).

### Stato

```bash
sudo /usr/local/sbin/muse-deploy status      # docker compose ps + immagine corrente/precedente, backup, overlay
```

Dalla workstation, con la chiave di deploy (accetta solo `status`, `rollback`, `deploy <digest>`):

```bash
ssh -i muse_deploy muse-deploy@<vps> status
```

### Deploy manuale di un digest

```bash
# digest dall'ultimo build (riepilogo del job "build" oppure):
gh api /users/haxurus/packages/container/muse/versions --jq '.[0].name'
# facoltativo, da una macchina fidata:
gh attestation verify oci://ghcr.io/haxurus/muse@sha256:<digest> --repo haxurus/muse
# sul VPS:
sudo /usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256:<digest>
```

`muse-deploy` valida segreti e `.env`, estrae il bundle Compose dall'immagine, ferma la flotta, fa il backup, avvia e attende che tutti gli otto servizi siano healthy (max 240 s). Se la nuova release fallisce ripristina da solo configurazione, backup e immagine precedente. Un secondo comando concorrente esce con codice 75 (lock `/run/lock/muse-deploy.lock`).

### Rollback

```bash
sudo /usr/local/sbin/muse-deploy rollback
```

oppure GitHub → Actions → **Rollback production** (richiede approvazione dell'environment):

```bash
gh workflow run rollback.yml --repo haxurus/muse --ref main
```

Attenzione: il rollback ripristina il backup pre-deploy della release precedente, quindi **i dati scritti dopo quel deploy spariscono dal live** (restano nel backup `muse-rollback-safety-<timestamp>.tar.gz`). Un secondo rollback consecutivo viene rifiutato: per tornare avanti si fa un normale deploy. Se `rollback` rifiuta per backup mancante, seguire la [recovery manuale](DEPLOYMENT.md#manual-recovery).

### Backup e restore

I backup vengono creati automaticamente a ogni deploy/rollback (flotta ferma) e potati dopo 14 giorni, tranne quelli referenziati da `previous-backup` e `last-backup`. La cache audio è esclusa. Stanno sullo stesso disco: copiarli periodicamente fuori dal VPS.

```bash
sudo ls -lt /srv/docker/muse/backups | head
sudo cat /srv/docker/muse/.deploy-state/previous-backup /srv/docker/muse/.deploy-state/last-backup
sudo tar -tzf /srv/docker/muse/backups/muse-<timestamp>.tar.gz     # contenuto
```

Backup manuale e restore completo: vedi [DEPLOYMENT.md "Manual recovery"](DEPLOYMENT.md#manual-recovery) (ferma la flotta, verifica che nulla giri, `tar` di `data/bot-0*/db.sqlite*` e `data/orchestrator/*.json*`, poi `chown -R 10001:10001 data`).

### Release manuale (GitHub Actions non disponibile)

Dettagli in [DEPLOYMENT.md "Manual release"](DEPLOYMENT.md#manual-release-github-actions-unavailable). PAT classico con solo `write:packages`, scadenza breve:

```bash
sudo -i     # tutto come root, anche il clone (lo script richiede root)
rm -rf /tmp/muse-release && git clone --branch main https://github.com/haxurus/muse.git /tmp/muse-release
cd /tmp/muse-release
docker login ghcr.io -u haxurus
./ops/manual-release.sh            # --no-push: tutto tranne la pubblicazione
docker logout ghcr.io
/usr/local/sbin/muse-deploy deploy ghcr.io/haxurus/muse@sha256:<digest stampato>
```

Lo script rifiuta un checkout diverso da `origin/main`, esegue lint/typecheck/test/build, valida Compose, fa lo smoke test del pot-provider e pubblica `:main` e `:sha-<commit>`. Builda solo per l'architettura del VPS e senza attestazioni.

### Deploy automatico da GitHub Actions

Workflow `.github/workflows/deploy.yml` (**Deploy production**): su push a `main` esegue `validate` → `build` (multi-arch, SBOM, provenance, attestazione) → `deploy`. Il job `deploy` gira solo se:

- la variabile di repository `ENABLE_VPS_DEPLOY` vale `true`;
- l'environment `production` (limitato a `main`, con reviewer obbligatorio) approva;
- sono presenti i secret d'environment `VPS_HOST`, `VPS_PORT`, `VPS_DEPLOY_KEY`, `VPS_KNOWN_HOSTS`.

Deploy e rollback condividono il gruppo di concorrenza `muse-production`. Per ripetere build e deploy senza nuovi commit:

```bash
gh workflow run deploy.yml --repo haxurus/muse --ref main
```

Per sospendere i deploy automatici: impostare `ENABLE_VPS_DEPLOY` a un valore diverso da `true` (le immagini continuano a essere buildate).

### Aggiornare il firewall quando cambia una rete

Il firewall (`/usr/local/sbin/muse-host-firewall`, eseguito a boot da `muse-firewall.service` prima di Docker) **non** viene aggiornato da `muse-deploy`. Se una release aggiunge o rinomina un bridge (`com.docker.network.bridge.name` in `deploy/docker-compose.prod.yml`), il nome va aggiunto anche in `security/host-firewall.sh` (`INTERNAL_IFACES` / `EGRESS_IFACES`; `tests/deploy-hardening.test.ts` verifica la coerenza) e lo script va reinstallato sul VPS **prima** del deploy:

```bash
curl -fsSL https://raw.githubusercontent.com/haxurus/muse/main/security/host-firewall.sh -o /tmp/muse-host-firewall
sudo install -m 755 -o root -g root /tmp/muse-host-firewall /usr/local/sbin/muse-host-firewall && rm /tmp/muse-host-firewall
sudo /usr/local/sbin/muse-host-firewall
sudo iptables -S MUSE-FORWARD | head -30
```

In alternativa rieseguire `sudo ./ops/install-vps.sh /path/to/muse_deploy.pub` da un checkout aggiornato (idempotente).

## 3. Super console

UI: `https://<dashboard-host>/it/super` (o `/en/super`), solo per l'utente in `MUSE_SUPER_ADMIN_USER_ID` (`.env`). Vuoto = super console disabilitata per tutti. Riferimento: [SUPER_CONSOLE.md](SUPER_CONSOLE.md).

| Esigenza | Dove | Note |
| --- | --- | --- |
| Stato dei bot | **BOT · Stato dei worker** | Pronto / Non pronto / Offline, server, player, uptime, link di invito |
| Canale di stato | **STATO · Canale di log dei bot** | Server + canale + ruoli (max 10). "Invia messaggio di prova" mostra l'esito per bot (`MISSING_PERMISSIONS`, `CHANNEL_NOT_FOUND`, …). Servono View Channel, Send Messages, Embed Links. Salvato in `platform-settings.json` |
| Piani | "Gestisci piano" sul server | FREE / TIER1 Plus / TIER2 Pro / TIER3 Brand, nessun pagamento online. Un downgrade applica subito i limiti. Scadenze riportate a FREE ogni 10 minuti. Salvato in `plans.json` |
| Coupon | Sezione **Coupon** | Applicati quando si assegna un piano; quelli `public` compaiono come promozione su `/it/pricing` |
| Recapiti pubblici | **Recapiti pubblici** | Email / Discord / URL mostrati nella pagina prezzi; campo vuoto = nascosto. GitHub è sempre elencato |
| Blocklist | **POLICY · Blacklist**, "Blocca ed espelli" | GUILD: tutti i bot escono e riescono subito se reinvitati. USER: interazioni rifiutate e login dashboard negato. Max 5000 per tipo. Sbloccare non fa rientrare i bot |
| Audit | **AUDIT · Azioni super-admin** | Ultime 1000 voci in `super-audit.json`; esito `ok` / `partial` / `failed` |

La blocklist sui worker vive solo in memoria: l'orchestratore la ripubblica all'avvio, a ogni modifica e ogni 60 secondi, quindi un worker riavviato torna conforme entro un minuto. Esito `partial` = salvato, ma qualche worker non ha ricevuto il push (il loop riprova).

Le mutazioni del dashboard producono anche una riga JSON `dashboard_mutation` nei log:

```bash
dc logs --since 24h dashboard | grep dashboard_mutation
```

## 4. Log e diagnostica di base

I log usano il driver `json-file` (10 MB × 3 file per container).

```bash
sudo /usr/local/sbin/muse-deploy status
dc ps
dc logs --tail 200 orchestrator
dc logs --tail 200 -f muse-03
dc logs --since 1h muse-01 muse-02 muse-03 muse-04 muse-05 | grep -iE 'error|warn|failed'
sudo docker inspect --format '{{.State.Health.Status}} restarts={{.RestartCount}}' muse-muse-01-1
sudo docker inspect --format '{{json .State.Health.Log}}' muse-orchestrator-1
```

Healthcheck dei servizi: worker = esiste `/tmp/muse-ready` (scritto dopo ready Discord e registrazione comandi); dashboard `/health` (3000); orchestratore `/health` (3100); edge `/edge-health` (8080); pot-provider `/ping` (4416).

## 5. Troubleshooting per sintomo

### Worker non pronto (Non pronto / Offline, healthcheck `unhealthy`)

```bash
sudo docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' muse-muse-0N-1
dc logs --tail 200 muse-0N
```

- `Muse failed to start (<codice>)` con riavvii continui: di solito token Discord non valido o revocato → [§7 Rotazione token](#7-rotazione-del-token-di-un-worker). Durante un deploy questo fa fallire subito l'health wait e scatta il ripristino automatico.
- `Failed to apply database migrations` → vedi [Migrazioni Prisma](#migrazioni-prisma).
- `Required secret is empty: …` (da `muse-deploy`): riempire il file indicato in `secrets/`.
- Worker raggiungibile ma non `ready`: problemi di gateway Discord o DNS/uscita → vedi [Firewall e DNS](#firewall-e-dns).
- Riavvio del singolo worker: `sudo docker restart muse-muse-0N-1`.

### YouTube: "Sign in to confirm you're not a bot" / PO token provider

1. Verificare che il pot-provider sia healthy e generi token dopo un `/play` YouTube:

   ```bash
   sudo docker inspect --format '{{.State.Health.Status}}' muse-pot-provider-1
   sudo docker logs --tail 50 muse-pot-provider-1
   sudo docker exec muse-muse-01-1 node -e "fetch('http://muse-pot:4416/ping').then(r=>console.log(r.status)).catch(e=>console.log(e.message))"
   ```

2. Se il provider non risponde: `sudo docker restart muse-pot-provider-1`. Controllare anche che i bridge `muse-p01..05` siano nel firewall (sezione 2) e che `muse-eg` abbia uscita Internet.
3. Se il messaggio persiste con provider sano, il blocco è sull'IP: aggiungere o rinnovare i cookie (sotto). PO token e cookie lavorano insieme.

Aggiornamento del provider: tag + digest in `deploy/docker-compose.prod.yml`, `ARG BGUTIL_POT_VERSION` nel Dockerfile e hash in `deploy/yt-dlp-plugins-requirements.txt`, tutti insieme (un test lo impone). Vedi [DEPLOYMENT.md "YouTube PO tokens"](DEPLOYMENT.md#youtube-po-tokens-automatic).

### Cookie YouTube

Account Google **dedicato**, export in formato Netscape `cookies.txt` (procedura in [DEPLOYMENT.md "YouTube cookies"](DEPLOYMENT.md#youtube-cookies-optional-fallback)). File vuoto = nessun cookie.

```bash
sudo install -m 640 -o root -g 10001 /tmp/youtube_cookies.txt /srv/docker/muse/secrets/youtube_cookies && shred -u /tmp/youtube_cookies.txt
sudo docker restart muse-muse-01-1 muse-muse-02-1 muse-muse-03-1 muse-muse-04-1 muse-muse-05-1
sudo find /srv/docker/muse/secrets -maxdepth 1 -type f -printf '%m %u:%g %p\n'
```

I cookie scadono: quando il messaggio ricompare nei log dei worker, riesportarli.

### Aggiornare yt-dlp

yt-dlp è fissato nell'immagine (`ARG YT_DLP_VERSION`, lock con hash in `deploy/yt-dlp-requirements.txt`); l'auto-update è disabilitato (`YT_DLP_AUTO_UPDATE=false`) e non va abilitato.

```bash
sudo docker exec muse-muse-01-1 yt-dlp --version          # versione in esecuzione
gh workflow run yt-dlp-refresh.yml --repo haxurus/muse --ref main   # forza il controllo (gira ogni giorno)
```

Il workflow **Refresh yt-dlp pin** apre una PR di bump. Essendo aperta con `GITHUB_TOKEN` la CI non parte da sola: chiudere e riaprire la PR, attendere i check, fare merge → build e deploy normali. Bump manuale:

```bash
python3 .github/scripts/yt-dlp-lock.py <versione> deploy/yt-dlp-requirements.txt
# poi aggiornare ARG YT_DLP_VERSION nel Dockerfile alla stessa versione
```

### Il bot non entra in vocale

Il bot risponde con un messaggio esplicito; i più comuni:

- permessi mancanti nel canale vocale: **Visualizza canale, Connettiti, Parla** (testuale: Visualizza canale, Invia messaggi, Incorpora link);
- canale pieno, canale stage, thread/forum/chat vocale come canale testuale (non supportati dal pilota);
- bot già assegnato a un altro canale vocale dello stesso server;
- piano: oltre i primi N bot del piano (FREE = 1, Plus = 2, Pro/Brand = 5, in ordine `muse-01`, `muse-02`, …) i bot rifiutano i comandi con un messaggio che indica quelli inclusi → controllare "Gestisci piano" in super console;
- utente o server in blocklist (risposta "Non puoi usare questo bot.").

Per i pilota (`MUSE_COMPOSE_OVERLAYS`): `503` = bot non pronto; `504` = esito non confermato (controllare `/queue` prima di riprovare). Log lato worker e orchestratore:

```bash
dc logs --since 30m muse-0N orchestrator
```

Vedi [BOT_ONE_PLAYBACK.md](BOT_ONE_PLAYBACK.md) per il comportamento dettagliato.

### Dashboard: login Discord OAuth

- `?login=failed`: redirect URI non registrato esattamente come `https://<dashboard-host>/auth/discord/callback`, `MUSE_DASHBOARD_PUBLIC_URL` non è un'origine https nuda (niente path), client secret errato, stato scaduto (>10 min), oppure **orchestratore irraggiungibile** (il login è fail-closed).
- `?login=blocked`: l'utente è nella blocklist USER.
- Super console o pulsanti di invito assenti: `MUSE_SUPER_ADMIN_USER_ID` vuoto o diverso dall'ID Discord dell'utente.
- Tutti disconnessi: le sessioni sono in memoria, un riavvio del dashboard le azzera (normale).

```bash
sudo grep -E '^MUSE_(DASHBOARD_PUBLIC_URL|DASHBOARD_DISCORD_CLIENT_ID|SUPER_ADMIN_USER_ID|DASHBOARD_SESSION_HOURS)=' /srv/docker/muse/.env
dc logs --tail 200 dashboard dashboard-edge
sudo docker network inspect muse-edge --format '{{range .Containers}}{{.Name}} {{end}}'   # deve esserci NPM + edge
```

Dopo aver modificato `.env` o il client secret: `dc up -d dashboard` (ricrea il container con i nuovi valori). Se il sito non risponde affatto, verificare il Proxy Host NPM → `muse-dashboard:8080` e che NPM sia ancora collegato a `muse-edge` ([DEPLOYMENT.md §7](DEPLOYMENT.md#7-configure-nginx-proxy-manager)).

### Orchestratore irraggiungibile

Sintomi: dashboard con errori `502`, login `failed`, super console vuota, canale di stato che non annuncia.

```bash
sudo docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' muse-orchestrator-1
dc logs --tail 200 orchestrator
sudo docker exec muse-orchestrator-1 node -e "fetch('http://127.0.0.1:3100/health').then(r=>console.log(r.status)).catch(e=>console.log(e.message))"
sudo docker restart muse-orchestrator-1
```

- `Failed to start orchestrator:` all'avvio: spesso file di stato corrotto (sotto), `workers.json` non valido o token troppo corti (minimo 32 caratteri).
- `401` tra orchestratore e un worker dopo la modifica di un `control_token_0N`: riavviare **insieme** orchestratore e worker (§7).

### File di stato corrotto (`loadWithBackup`)

All'avvio ogni file di `data/orchestrator` viene validato. Se il primario è illeggibile o fuori schema e il `.bak` è valido, l'orchestratore parte e logga `… is invalid; recovered from ….bak`. Se nessuno dei due è valido rifiuta di partire con `… is unreadable or has an invalid schema, and no valid backup exists at … Restore it from a backup before starting the orchestrator.`

Ripristino del solo file colpito (es. `plans.json`) dall'ultimo backup:

```bash
sudo docker stop muse-orchestrator-1
sudo ls -lt /srv/docker/muse/backups | head
B=/srv/docker/muse/backups/muse-<timestamp>.tar.gz
sudo mkdir -m 700 /tmp/muse-restore
sudo tar -C /tmp/muse-restore -xzf "$B" data/orchestrator/plans.json
sudo cp -a /srv/docker/muse/data/orchestrator/plans.json /srv/docker/muse/data/orchestrator/plans.json.corrupt   # conserva la copia guasta
sudo install -m 600 -o 10001 -g 10001 /tmp/muse-restore/data/orchestrator/plans.json /srv/docker/muse/data/orchestrator/plans.json
sudo rm -rf /tmp/muse-restore
sudo docker start muse-orchestrator-1 && dc logs --tail 50 orchestrator
```

Le modifiche successive al backup per quel file vanno perse (consultare l'audit). Non avviare mai due orchestratori sullo stesso volume.

### Migrazioni Prisma

Ogni worker applica le migrazioni (`prisma migrate deploy`) all'avvio, su `data/bot-0N/db.sqlite`, tramite `dist/scripts/migrate-and-start.js`. Non si eseguono a mano in produzione.

- Log `Failed to apply database migrations:` seguito dall'errore Prisma, container che esce: durante un deploy `muse-deploy` ripristina automaticamente immagine e backup pre-deploy. Fuori da un deploy: `sudo /usr/local/sbin/muse-deploy rollback`.
- Database danneggiato su un solo worker: ripristinare `data/bot-0N/db.sqlite*` da un backup seguendo la [recovery manuale](DEPLOYMENT.md#manual-recovery) (flotta ferma, poi `chown -R 10001:10001 /srv/docker/muse/data`).
- Una migrazione nuova va sempre provata con un backup recente; il rollback riporta il DB allo stato pre-deploy.

### Firewall e DNS

```bash
sudo systemctl status muse-firewall.service
sudo iptables -S FORWARD | grep DOCKER-USER          # deve esserci il jump
sudo iptables -S MUSE-FORWARD
sudo iptables -S MUSE-INPUT
cat /etc/resolv.conf; resolvectl dns
sudo /usr/local/sbin/muse-host-firewall              # riapplica (idempotente) e stampa i DNS ammessi
```

- Bot o dashboard senza rete dopo un cambio di resolver: il firewall ammette DNS solo verso i resolver rilevati al momento dell'esecuzione → rieseguire `muse-host-firewall`.
- `WARNING: FORWARD has no jump to DOCKER-USER`: Docker usa il backend nftables, le regole non si applicano.
- firewalld o `netfilter-persistent` che ricaricano le regole a runtime cancellano le catene Muse → rieseguire lo script.
- Rimozione completa (solo per diagnosi): `sudo /usr/local/sbin/muse-host-firewall --remove`, poi riapplicare.

### Disco pieno

```bash
df -h /var/lib/docker /srv/docker/muse
sudo docker system df
sudo du -sh /srv/docker/muse/data/bot-0*/cache /srv/docker/muse/backups
sudo docker image ls ghcr.io/haxurus/muse
```

- `muse-deploy` pota le vecchie immagini Muse se restano < 5 GiB e **rifiuta** il deploy sotto i 3 GiB (`Less than 3 GiB free …`), prima di fermare la flotta.
- Cache audio per worker limitata da `CACHE_LIMIT` in `.env` (default `2GB`, quindi fino a ~10 GB per cinque worker).
- Dopo release manuali: `sudo docker builder prune`.
- Backup vecchi: potati dopo 14 giorni a ogni deploy; non cancellare quelli referenziati in `.deploy-state/previous-backup` e `last-backup`.
- I log dei container sono già limitati a 30 MB ciascuno.

## 6. Checklist post-deploy

```bash
sudo /usr/local/sbin/muse-deploy status                    # 8 servizi healthy, Current = digest atteso
dc logs --since 15m | grep -iE 'error|failed|recovered from' | head -50
sudo docker logs --tail 20 muse-pot-provider-1
```

- [ ] `status` mostra tutti gli otto servizi `healthy` e `Current` è il digest appena deployato; `Previous` è la release precedente.
- [ ] Super console: 5/5 bot "Pronto", server e player coerenti con prima del deploy.
- [ ] Canale di stato: ogni bot del server ha postato "Bot avviato" / "Bot started" (se configurato).
- [ ] Login dashboard con Discord riuscito; `/it/pricing` mostra piani e recapiti.
- [ ] `/play` YouTube funzionante in un server di test; nessun "Sign in to confirm you're not a bot" nei log.
- [ ] Nessun `recovered from ….bak` nei log dell'orchestratore.
- [ ] Se la release cambiava reti: firewall aggiornato prima del deploy e `sudo iptables -S MUSE-FORWARD` include i nuovi bridge.
- [ ] Spazio libero ancora > 5 GiB (`df -h /var/lib/docker /srv/docker/muse`).

## 7. Rotazione del token di un worker

### Token Discord del bot (`discord_token_0N`)

1. Discord Developer Portal → applicazione del bot N → **Bot** → **Reset Token**. Il vecchio token smette subito di funzionare.
2. Sul VPS, sostituire il contenuto (una sola riga, nessun altro testo):

   ```bash
   sudoedit /srv/docker/muse/secrets/discord_token_0N
   sudo stat -c '%a %U:%G' /srv/docker/muse/secrets/discord_token_0N    # atteso: 640 root:10001
   sudo docker restart muse-muse-0N-1
   dc logs --tail 50 -f muse-0N
   sudo docker inspect --format '{{.State.Health.Status}}' muse-muse-0N-1
   ```

3. Verificare in super console che il bot sia "Pronto". Non avviare mai due container con lo stesso token.

### Token di controllo (`control_token_0N`)

Usato in entrambe le direzioni tra orchestratore e worker N: va riavviato **insieme** su entrambi i lati ([ORCHESTRATOR.md](ORCHESTRATOR.md#control-token-reuse-and-rotation)). Minimo 32 caratteri.

```bash
sudo sh -c 'umask 027 && openssl rand -hex 32 > /srv/docker/muse/secrets/control_token_0N'
sudo chown root:10001 /srv/docker/muse/secrets/control_token_0N && sudo chmod 640 /srv/docker/muse/secrets/control_token_0N
sudo docker restart muse-orchestrator-1 muse-muse-0N-1
dc logs --tail 50 orchestrator muse-0N
```

Lo stesso schema (file + riavvio dell'orchestratore e del dashboard) vale per `orchestrator_api_token`, condiviso da `orchestrator` e `dashboard`.
