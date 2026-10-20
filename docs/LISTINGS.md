# Bot listings

Ready-to-paste copy for the Discord App Directory and bot lists (Italian and English).

> **Muse is not open to the public yet.** It is self-hostable, and the maintainer runs the bots for
> servers that asked for access. Do not submit these listings, and keep the bot's **Public Bot**
> switch off in the Developer Portal, until the access policy changes. Once it is open, fill in the
> TODO links below first: a listing without a privacy policy and terms is not accepted.

Check the current character limits in the Developer Portal before pasting. The copy below is
within the limits at the time of writing (short line under 100 characters).

## Names and tags

- Name: `Muse`
- Tags (pick up to five from the list the directory offers): `Music`, `YouTube`, `Spotify`, `SoundCloud`, `Utility`

## Short description

English:

```text
Music bot for voice channels: YouTube, Spotify and SoundCloud, with a web dashboard.
```

Italiano:

```text
Bot musicale per i canali vocali: YouTube, Spotify e SoundCloud, con dashboard web.
```

## Long description

English:

```text
Muse plays music in your voice channels from YouTube, Spotify and SoundCloud links or search terms.
Queue songs, skip, loop, shuffle, seek and set the volume, and save favorite queries for the whole server.
Each server picks its own default volume, queue page size, idle timeout and language (English or Italian).
Several Muse bots can be added to the same server, and saved groups apply settings to a chosen set of them.
The web dashboard, opened with your Discord login, manages the settings of every server where you have
Manage Server, exports the server data and removes saved favorites on request.
Muse is self-hosted and is not open to the public yet: access is granted on request.
```

Italiano:

```text
Muse riproduce musica nei tuoi canali vocali da link o ricerche di YouTube, Spotify e SoundCloud.
Metti in coda i brani, salta, ripeti, mescola, cerca nel brano e regola il volume, e salva ricerche
preferite per tutto il server. Ogni server sceglie il proprio volume predefinito, la dimensione della pagina
della coda, il tempo di inattività e la lingua (italiano o inglese). Più bot Muse possono far parte dello
stesso server, e i gruppi applicano le impostazioni a un insieme scelto di bot. La dashboard web, con accesso tramite Discord, gestisce le impostazioni
di ogni server dove hai il permesso Gestisci server, esporta i dati del server ed elimina i preferiti
salvati su richiesta. Muse è self-hosted e non è ancora aperto al pubblico: l'accesso si concede su richiesta.
```

## Invite permissions

The invite link asks for exactly these permissions (the value is `BOT_INVITE_PERMISSIONS` in
`src/dashboard/server.ts`, `70339584`):

| Permission | Bit | Why the bot needs it |
| --- | --- | --- |
| View Channels | 1024 | See the voice channel it joins and the channel where commands are sent |
| Send Messages | 2048 | Answer commands and post its status message |
| Embed Links | 16384 | Send queue and now-playing messages |
| Read Message History | 65536 | Read the channel history that goes with sending messages there |
| Connect | 1048576 | Join a voice channel |
| Speak | 2097152 | Play audio in the voice channel |
| Change Nickname | 67108864 | Brand plan only: set the bot's nickname and banner in one server |

The bits add up to `70339584`. The invite does not ask for Administrator or any moderation permission.

Invite link template (replace the application id; the dashboard builds the same link per bot):

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=70339584
```

## Required links

| Field | Value |
| --- | --- |
| Privacy policy | TODO: public URL of the privacy policy (what is stored: favorites, server settings, OAuth session in memory, retention of 30 days after leaving a server) |
| Terms of service | TODO: public URL of the terms |
| Support server | TODO: permanent Discord invite to the support server |
| Website | TODO: public dashboard URL (`MUSE_DASHBOARD_PUBLIC_URL`) |

## Before submitting

- Open the access policy first (see the note at the top), then switch on **Public Bot**.
- Fill in every TODO above and check that the links open without a login.
- Keep the copy in step with what the bot does: the dashboard export, member removal and self-service
  deletion described above are documented in `docs/DASHBOARD.md` ("Data rights").
