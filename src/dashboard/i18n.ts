/**
 * Web UI languages of the dashboard (Italian and English, Sentinel model).
 *
 * Every HTML view lives under a language prefix (`/it/...`, `/en/...`). The server
 * renders the HTML templates in `dashboard/` once per language at startup:
 * `{{key}}` placeholders are replaced with HTML-escaped strings from the typed
 * dictionaries below, `{{{key}}}` with trusted server-generated markup (the
 * language switcher). The single page app loads its own dictionary from
 * `/assets/i18n/<lang>.json`.
 */

export const LOCALES = ['it', 'en'] as const;

export type Locale = typeof LOCALES[number];

/** Used when the browser expresses no preference for Italian or English. */
export const DEFAULT_LOCALE: Locale = 'en';

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

const QUALITY = /^\s*q\s*=\s*([\d.]+)\s*$/iu;
const MAX_LANGUAGE_RANGES = 32;

/**
 * Picks the UI language from an Accept-Language header: the Italian or English
 * range with the highest quality wins (ties keep header order); anything else,
 * or no header at all, falls back to English.
 */
export const preferredLocale = (header: string | string[] | undefined): Locale => {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  let best: {locale: Locale; quality: number} | undefined;

  for (const range of raw.split(',').slice(0, MAX_LANGUAGE_RANGES)) {
    const [tag, ...parameters] = range.split(';');
    const primary = tag.trim().toLowerCase().split(/[-_]/u)[0];
    if (!isLocale(primary)) {
      continue;
    }

    let quality = 1;
    for (const parameter of parameters) {
      const match = QUALITY.exec(parameter);
      if (match) {
        quality = Number.parseFloat(match[1]);
      }
    }

    if (!Number.isFinite(quality) || quality <= 0) {
      continue;
    }

    if (best === undefined || quality > best.quality) {
      best = {locale: primary, quality};
    }
  }

  return best === undefined ? DEFAULT_LOCALE : best.locale;
};

/** `/it` + path, e.g. localizedPath('en', '/dashboard') === '/en/dashboard'. */
export const localizedPath = (locale: Locale, path = ''): string => `/${locale}${path}`;

const HTML_ESCAPES = new Map<string, string>([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ['\'', '&#39;'],
]);

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, character => HTML_ESCAPES.get(character) ?? character);

const PLACEHOLDER = /\{\{\{([\w.-]+)\}\}\}|\{\{([\w.-]+)\}\}/gu;

/**
 * Replaces `{{key}}` with the HTML-escaped value and `{{{key}}}` with trusted markup.
 * Single pass: substituted text is never scanned again. Unknown keys throw, so a
 * typo in a template fails at startup (and in the tests) instead of shipping.
 */
export const renderTemplate = (
  template: string,
  values: Readonly<Record<string, string>>,
  markup: Readonly<Record<string, string>> = {},
): string => template.replace(PLACEHOLDER, (_match: string, rawKey: string | undefined, key: string | undefined) => {
  if (rawKey !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(markup, rawKey)) {
      throw new Error(`Unknown template markup: ${rawKey}`);
    }

    return markup[rawKey];
  }

  const name = key ?? '';
  if (!Object.prototype.hasOwnProperty.call(values, name)) {
    throw new Error(`Unknown template key: ${name}`);
  }

  return escapeHtml(values[name]);
});

/* ---------- Dictionaries (home page, development notice, shared chrome) ---------- */

const it = {
  lang: {
    label: 'Lingua',
  },
  meta: {
    homeTitle: 'Muse · Music bot Discord per più canali vocali',
    homeDescription: 'Cinque music bot Discord e una dashboard: musica da YouTube, Spotify e SoundCloud in fino a cinque canali vocali insieme. Slash command, open source.',
    ogLocale: 'it_IT',
    ogLocaleAlternate: 'en_US',
    ogImageAlt: 'Muse: music bot Discord per cinque canali vocali insieme, con YouTube, Spotify e SoundCloud.',
    developmentTitle: 'Muse · Accesso limitato',
    pricingTitle: 'Prezzi · Piani gratuiti e premium del music bot Discord Muse',
    pricingDescription: 'Confronta i piani di Muse: music bot Discord gratuito con YouTube, Spotify e SoundCloud, più i piani Plus, Pro e Brand con più bot in canali vocali diversi, 24/7 e nome del bot personalizzato.',
    appNoscript: 'Muse Control richiede JavaScript.',
  },
  nav: {
    homeLabel: 'Muse - Home',
    label: 'Navigazione principale',
    openMenu: 'Apri menu',
    features: 'Funzioni',
    how: 'Come funziona',
    security: 'Sicurezza',
    faq: 'FAQ',
    pricing: 'Prezzi',
    login: 'Accedi',
    add: 'Aggiungi a Discord',
    openDashboard: 'Apri la dashboard',
  },
  hero: {
    kicker: 'Music bot Discord · Open source',
    line1: 'Cinque bot.',
    line2: 'Una dashboard.',
    line3: 'La tua musica.',
    text: 'Muse mette nel tuo server Discord cinque music bot indipendenti: fino a cinque canali vocali in riproduzione nello stesso momento. Li configuri da un’unica dashboard, uno alla volta o a gruppi.',
  },
  stream: {
    title: 'muse://sessioni',
    live: 'live',
    row1: '#Sala principale · playlist lo-fi',
    row2: '#Gaming · link Spotify convertito',
    row3: '#Studio · 12 brani in coda',
    row4: '#Eventi · pausa per l’annuncio',
    row5: '#Lounge · canale vuoto',
    playing: 'in riproduzione',
    queued: 'in coda',
    paused: 'in pausa',
    disconnected: 'disconnesso',
    caption: 'esempio illustrativo',
    bots: '5 bot',
    servers: '1 server',
  },
  stats: {
    bots: 'bot indipendenti',
    dashboard: 'dashboard per tutti',
    ports: 'porte pubbliche per i bot',
    permissions: 'permessi Discord richiesti',
  },
  features: {
    kicker: 'Funzioni',
    title: 'Più vocali, un solo pannello.',
    text: 'Ogni bot è un account Discord separato con la propria coda. La dashboard li tiene insieme senza mescolarli.',
    bots: {
      kicker: 'Cinque bot',
      title: 'Cinque vocali insieme',
      text: 'Cinque account bot distinti, ognuno nel proprio container isolato. Nello stesso server possono suonare fino a cinque canali vocali contemporaneamente.',
    },
    commands: {
      kicker: 'Comandi',
      title: 'Slash command per ogni bot',
      before: 'Scegli il bot nell’elenco dei comandi di Discord e usa',
      after: 'e gli altri.',
    },
    login: {
      kicker: 'Dashboard',
      title: 'Accesso con Discord',
      text: 'Vedi solo i server che amministri: proprietario, Amministratore o Gestisci server. I permessi vengono ricontrollati a ogni modifica.',
    },
    groups: {
      kicker: 'Gruppi',
      title: 'Uno, alcuni o un gruppo',
      text: 'Configura un bot alla volta, una selezione multipla o gruppi salvati per server, come Principali = 1+2+3 ed Eventi = 4+5. I gruppi possono sovrapporsi.',
    },
    settings: {
      kicker: 'Impostazioni',
      title: 'Ogni bot come vuoi',
      text: 'Lingua del bot, volume predefinito, limite playlist, uscita quando il canale resta vuoto, attesa a fine coda, annuncio del brano successivo, volume ridotto quando si parla, pagina della coda e risposte private.',
    },
    sources: {
      kicker: 'Sorgenti',
      title: 'YouTube, Spotify, SoundCloud',
      text: 'Ricerca, link e playlist YouTube. Link Spotify convertiti in brani YouTube. Link SoundCloud. L’audio già scaricato resta in una cache locale.',
    },
  },
  how: {
    kicker: 'Come funziona',
    title: 'Dall’invito alla vocale, in quattro passi.',
    invite: {
      title: 'Invita i bot',
      text: 'Ogni bot ha il proprio invito. Aggiungi al server solo quelli che ti servono.',
    },
    login: {
      title: 'Accedi con Discord',
      text: 'La dashboard mostra i server che amministri e i bot presenti in ciascuno.',
    },
    configure: {
      title: 'Configura per server o per gruppi',
      text: 'Applica le impostazioni a un bot, a una selezione o a un gruppo salvato.',
    },
    play: {
      title: 'Usa /play nella vocale',
      before: 'Entra in un canale vocale e lancia',
      after: 'sul bot che vuoi. Un bot per canale.',
    },
  },
  selfHosted: {
    kicker: 'Self-hosted',
    title: 'Sul tuo server, con le tue regole.',
    textBeforeFork: 'Muse è un fork open source di',
    textBeforeCode: ', rilasciato con licenza MIT. Il codice è su',
    textEnd: '.',
    apps: {
      title: 'Crea cinque applicazioni Discord',
      text: 'Una per bot. Ogni bot ha il proprio token e la propria cartella dati.',
    },
    secrets: {
      title: 'Prepara i segreti',
      before: 'Token e credenziali vengono letti da Docker secret montati in',
      after: '.',
    },
    compose: {
      title: 'Avvia con Docker Compose',
      text: 'Bot, orchestratore e dashboard partono da un’immagine fissata per digest. Metti la dashboard dietro il tuo reverse proxy.',
    },
  },
  security: {
    kicker: 'Sicurezza',
    title: 'Isolati per progetto.',
    text: 'Un music bot non ha bisogno di moderare né di essere raggiungibile da Internet. Muse chiede il minimo e separa tutto il resto.',
    tokens: {
      title: 'Un token per bot',
      text: 'Ogni bot ha il proprio token Discord e i propri dati. Un bot non vede i segreti degli altri.',
    },
    containers: {
      title: 'Container blindati',
      text: 'Utente non root, filesystem in sola lettura, nessuna capability Linux, nessun accesso al socket Docker.',
    },
    ports: {
      title: 'Nessuna porta pubblica',
      text: 'I bot non espongono porte. La dashboard è raggiungibile solo tramite un edge proxy che non conosce alcun segreto.',
    },
    oauth: {
      title: 'Token OAuth lato server',
      text: 'Il token Discord dell’accesso resta nel processo della dashboard e non arriva mai al browser. Ogni modifica passa controlli CSRF e Origin.',
    },
    permissions: {
      title: 'Permessi minimi',
      text: 'Visualizza canali, Invia messaggi, Incorpora link, Leggi la cronologia, Connetti, Parla. Nessun permesso di moderazione.',
    },
  },
  faq: {
    kicker: 'FAQ',
    title: 'Domande frequenti.',
    voice: {
      question: 'Un music bot Discord può suonare in più canali vocali insieme?',
      answer: 'Un singolo bot può stare in un solo canale vocale per server. Muse usa cinque music bot indipendenti, quindi lo stesso server può avere musica in fino a cinque canali vocali nello stesso momento, ognuno con la propria coda.',
    },
    sources: {
      question: 'Quali sorgenti musicali supporta Muse?',
      answer: 'Ricerca, link e playlist di YouTube; link Spotify di brani, album e playlist, riprodotti tramite i brani corrispondenti su YouTube; link SoundCloud. Anche le dirette YouTube sono supportate.',
    },
    play: {
      question: 'Come si riproduce musica in un canale vocale Discord?',
      answer: 'Entra in un canale vocale ed esegui /play con il titolo del brano o un link, scegliendo il bot che vuoi dall’elenco dei comandi di Discord. Poi usa /queue, /skip, /pause, /resume, /volume e gli altri slash command.',
    },
    permissions: {
      question: 'Di quali permessi ha bisogno il bot?',
      answer: 'Solo sei: Visualizza canali, Invia messaggi, Incorpora link, Leggi la cronologia dei messaggi, Connettiti e Parla. Nessun permesso di moderazione.',
    },
    openSource: {
      question: 'Muse è gratuito e open source?',
      answer: 'Sì. Muse è un fork open source di museofficial/muse con licenza MIT. Puoi ospitarlo sulla tua infrastruttura con Docker Compose, con cinque applicazioni Discord e una dashboard.',
    },
    language: {
      question: 'In che lingue parla il bot?',
      answer: 'I messaggi del bot sono in inglese per impostazione predefinita e in italiano con /config set-language; i nomi dei comandi restano in inglese. La dashboard e questo sito sono in inglese e in italiano.',
    },
  },
  seo: {
    featureList: 'Cinque music bot Discord indipendenti, fino a cinque canali vocali in riproduzione insieme, YouTube, Spotify, SoundCloud, slash command, dashboard con accesso Discord, gruppi di bot per server',
  },
  cta: {
    title: 'Più vocali, nessun compromesso.',
    text: 'Aggiungi i bot, accedi con Discord e configura il primo server in pochi minuti.',
  },
  footer: {
    about: 'Music bot Discord self-hosted. Fork open source di',
    license: '(MIT).',
    navLabel: 'Link del sito',
    dashboard: 'Dashboard',
    credits: 'Muse © 2026 · Fatto da Haxurus',
    tagline: 'discord music · self-hosted',
  },
  development: {
    kicker: 'Accesso limitato',
    title: 'Muse è ancora in sviluppo.',
    text: 'Per ora i bot di Muse possono essere aggiunti a nuovi server solo dal proprietario del progetto.',
    follow: 'Puoi seguire lo sviluppo su GitHub oppure fare un fork del progetto e self-hostarlo sulla tua infrastruttura.',
    github: 'Stato del progetto su GitHub',
    fork: 'Fai un fork e self-hostalo',
    back: 'Torna alla home',
  },
  pricing: {
    kicker: 'Piani',
    title: 'Un piano per ogni server.',
    intro: 'Il piano Free include un bot musicale con tutti i comandi e le sorgenti. I livelli a pagamento aggiungono più bot in canali vocali diversi, il 24/7, limiti più alti e il supporto prioritario.',
    betaNotice: 'Muse è in beta: i pagamenti online non sono ancora attivi. Per attivare un piano contattami direttamente, lo configuro io sul tuo server.',
    unavailable: 'Impossibile caricare promozioni e recapiti in questo momento. Riprova tra poco.',
    monthly: 'Mensile',
    yearly: 'Annuale',
    billingLabel: 'Fatturazione',
    perMonth: '/mese',
    perYear: '/anno',
    freeForever: 'Gratis per sempre',
    save: 'risparmi {amount}',
    levelFree: 'FREE',
    level: 'LIVELLO {level}',
    joinBeta: 'Aggiungi a Discord',
    contactMe: 'Contattami',
    promotion: 'Promozione',
    promoCode: 'codice: {code}',
    promoUntil: 'fino al {date}',
    everyPlan: 'tutti i piani',
    yearlyScope: 'annuale',
    monthlyScope: 'mensile',
    tierLabelFree: 'Free',
    tierLabelTier1: 'Livello 1 · Plus',
    tierLabelTier2: 'Livello 2 · Pro',
    tierLabelTier3: 'Livello 3 · Brand',
    descFree: 'Un bot musicale con tutti i comandi: YouTube, Spotify e SoundCloud, coda, preferiti e dashboard.',
    descTier1: 'Due bot in due canali vocali insieme, gruppi di bot salvati, playlist più lunghe e supporto prioritario.',
    descTier2: 'Tutti e cinque i bot in cinque canali vocali insieme, il 24/7 e i limiti più alti.',
    descTier3: 'Tutto il Livello 2, più nome e banner del bot personalizzati nel tuo server.',
    featureBots: '{count} bot in vocale insieme',
    featureBot: '1 bot in vocale',
    featureGroups: '{count} gruppi di bot salvati',
    featureNoGroups: 'Nessun gruppo di bot salvato',
    featurePlaylist: '{count} brani per playlist',
    featureFavorites: '{count} preferiti',
    featureAlwaysOn: '24/7: resta in vocale anche da solo',
    featureSupport: 'Supporto prioritario',
    featureBranding: 'Nome e banner del bot personalizzati',
    compareTitle: 'Confronto completo',
    compareFeature: 'Funzione',
    compareCommands: 'Tutti i comandi e le sorgenti (YouTube, Spotify, SoundCloud)',
    compareBots: 'Bot in vocale insieme',
    compareGroups: 'Gruppi di bot salvati',
    comparePlaylist: 'Brani importati per playlist',
    compareFavorites: 'Preferiti per server',
    compareAlwaysOn: '24/7 (resta in un canale vuoto)',
    compareSupport: 'Supporto prioritario',
    compareBranding: 'Nome e banner del bot personalizzati',
    included: 'Incluso',
    notIncluded: 'Non incluso',
    contactKicker: 'Contatti',
    contactTitle: 'Vuoi attivare un piano?',
    contactText: 'Scrivimi indicando l’ID del server e il piano che ti interessa (mensile o annuale, ed eventuale codice sconto). Ti rispondo e attivo il piano manualmente.',
    contactEmail: 'Email',
    contactDiscord: 'Discord',
    contactWebsite: 'Sito',
    contactGithub: 'GitHub',
    contactGithubText: 'Apri una issue',
    faqTitle: 'Domande frequenti',
    faqExpiryQuestion: 'Cosa succede alla scadenza?',
    faqExpiryAnswer: 'Il server torna al piano Free: i bot oltre il primo smettono di rispondere e i limiti tornano quelli gratuiti. Le impostazioni non vengono cancellate.',
    faqBotsQuestion: 'Cosa vuol dire “bot in vocale insieme”?',
    faqBotsAnswer: 'Ogni bot Discord può stare in un solo canale vocale per server. Con due bot Muse hai musica in due canali contemporaneamente, con cinque in cinque, ognuno con la propria coda.',
    faqTrialQuestion: 'Posso provare prima di pagare?',
    faqTrialAnswer: 'Sì: il piano Free resta sempre disponibile e durante la beta posso attivare periodi di prova.',
  },

};

/** Nested dictionary shape; English must provide exactly the Italian keys. */
export type Messages = typeof it;

const en: Messages = {
  lang: {
    label: 'Language',
  },
  meta: {
    homeTitle: 'Muse · Discord Music Bot for Multiple Voice Channels',
    homeDescription: 'Five Discord music bots, one dashboard: play YouTube, Spotify and SoundCloud in up to five voice channels at once. Slash commands, open source.',
    ogLocale: 'en_US',
    ogLocaleAlternate: 'it_IT',
    ogImageAlt: 'Muse: Discord music bot for five voice channels at once, with YouTube, Spotify and SoundCloud.',
    developmentTitle: 'Muse · Limited access',
    pricingTitle: 'Pricing · Free and premium Discord music bot plans',
    pricingDescription: 'Compare Muse plans: a free Discord music bot with YouTube, Spotify and SoundCloud, plus Plus, Pro and Brand plans with more bots in different voice channels, 24/7 and a custom bot name.',
    appNoscript: 'Muse Control requires JavaScript.',
  },
  nav: {
    homeLabel: 'Muse - Home',
    label: 'Main navigation',
    openMenu: 'Open menu',
    features: 'Features',
    how: 'How it works',
    security: 'Security',
    faq: 'FAQ',
    pricing: 'Pricing',
    login: 'Sign in',
    add: 'Add to Discord',
    openDashboard: 'Open the dashboard',
  },
  hero: {
    kicker: 'Discord music bot · Open source',
    line1: 'Five bots.',
    line2: 'One dashboard.',
    line3: 'Your music.',
    text: 'Muse brings five independent music bots to your Discord server: up to five voice channels playing at the same time. You configure them from a single dashboard, one at a time or in groups.',
  },
  stream: {
    title: 'muse://sessions',
    live: 'live',
    row1: '#Main hall · lo-fi playlist',
    row2: '#Gaming · Spotify link converted',
    row3: '#Study · 12 tracks queued',
    row4: '#Events · paused for the announcement',
    row5: '#Lounge · empty channel',
    playing: 'playing',
    queued: 'queued',
    paused: 'paused',
    disconnected: 'disconnected',
    caption: 'illustrative example',
    bots: '5 bots',
    servers: '1 server',
  },
  stats: {
    bots: 'independent bots',
    dashboard: 'dashboard for all of them',
    ports: 'public ports for the bots',
    permissions: 'Discord permissions required',
  },
  features: {
    kicker: 'Features',
    title: 'More voice channels, one panel.',
    text: 'Every bot is a separate Discord account with its own queue. The dashboard keeps them together without mixing them up.',
    bots: {
      kicker: 'Five bots',
      title: 'Five voice channels at once',
      text: 'Five distinct bot accounts, each in its own isolated container. In the same server they can play in up to five voice channels simultaneously.',
    },
    commands: {
      kicker: 'Commands',
      title: 'Slash commands for every bot',
      before: 'Pick the bot in Discord’s command list and use',
      after: 'and the rest.',
    },
    login: {
      kicker: 'Dashboard',
      title: 'Sign in with Discord',
      text: 'You only see the servers you administer: owner, Administrator or Manage Server. Permissions are checked again on every change.',
    },
    groups: {
      kicker: 'Groups',
      title: 'One, a few or a group',
      text: 'Configure one bot at a time, a multiple selection or groups saved per server, such as Main = 1+2+3 and Events = 4+5. Groups can overlap.',
    },
    settings: {
      kicker: 'Settings',
      title: 'Every bot your way',
      text: 'Bot language, default volume, playlist limit, leaving when the channel is empty, wait time after the queue ends, next track announcements, lower volume while people speak, queue page size and private replies.',
    },
    sources: {
      kicker: 'Sources',
      title: 'YouTube, Spotify, SoundCloud',
      text: 'YouTube search, links and playlists. Spotify links converted to YouTube tracks. SoundCloud links. Audio that has already been downloaded stays in a local cache.',
    },
  },
  how: {
    kicker: 'How it works',
    title: 'From invite to voice channel, in four steps.',
    invite: {
      title: 'Invite the bots',
      text: 'Every bot has its own invite. Add only the ones your server needs.',
    },
    login: {
      title: 'Sign in with Discord',
      text: 'The dashboard shows the servers you administer and the bots in each one.',
    },
    configure: {
      title: 'Configure per server or per group',
      text: 'Apply settings to one bot, to a selection or to a saved group.',
    },
    play: {
      title: 'Use /play in voice',
      before: 'Join a voice channel and run',
      after: 'on the bot you want. One bot per channel.',
    },
  },
  selfHosted: {
    kicker: 'Self-hosted',
    title: 'On your server, by your rules.',
    textBeforeFork: 'Muse is an open source fork of',
    textBeforeCode: ', released under the MIT license. The code is on',
    textEnd: '.',
    apps: {
      title: 'Create five Discord applications',
      text: 'One per bot. Every bot has its own token and its own data folder.',
    },
    secrets: {
      title: 'Prepare the secrets',
      before: 'Tokens and credentials are read from Docker secrets mounted in',
      after: '.',
    },
    compose: {
      title: 'Start with Docker Compose',
      text: 'Bots, orchestrator and dashboard run from an image pinned by digest. Put the dashboard behind your reverse proxy.',
    },
  },
  security: {
    kicker: 'Security',
    title: 'Isolated by design.',
    text: 'A music bot does not need to moderate or to be reachable from the Internet. Muse asks for the minimum and keeps everything else apart.',
    tokens: {
      title: 'One token per bot',
      text: 'Every bot has its own Discord token and its own data. No bot can see the others’ secrets.',
    },
    containers: {
      title: 'Hardened containers',
      text: 'Non-root user, read-only filesystem, no Linux capabilities, no access to the Docker socket.',
    },
    ports: {
      title: 'No public ports',
      text: 'The bots expose no ports. The dashboard is only reachable through an edge proxy that holds no secrets.',
    },
    oauth: {
      title: 'Server-side OAuth token',
      text: 'The Discord sign-in token stays in the dashboard process and never reaches the browser. Every change goes through CSRF and Origin checks.',
    },
    permissions: {
      title: 'Minimal permissions',
      text: 'View Channels, Send Messages, Embed Links, Read Message History, Connect, Speak. No moderation permissions.',
    },
  },
  faq: {
    kicker: 'FAQ',
    title: 'Frequently asked questions.',
    voice: {
      question: 'Can a Discord music bot play in several voice channels at once?',
      answer: 'A single bot can only be in one voice channel per server. Muse runs five independent music bots, so the same server can have music in up to five voice channels at the same time, each with its own queue.',
    },
    sources: {
      question: 'Which music sources does Muse support?',
      answer: 'YouTube search, links and playlists; Spotify track, album and playlist links, played through the matching YouTube tracks; SoundCloud links. YouTube livestreams work too.',
    },
    play: {
      question: 'How do I play music in a Discord voice channel?',
      answer: 'Join a voice channel and run /play with a song name or a link, picking the bot you want from Discord’s command list. Then use /queue, /skip, /pause, /resume, /volume and the other slash commands.',
    },
    permissions: {
      question: 'Which permissions does the bot need?',
      answer: 'Only six: View Channels, Send Messages, Embed Links, Read Message History, Connect and Speak. No moderation permissions.',
    },
    openSource: {
      question: 'Is Muse free and open source?',
      answer: 'Yes. Muse is an open source fork of museofficial/muse under the MIT license. You can host it on your own infrastructure with Docker Compose, five Discord applications and one dashboard.',
    },
    language: {
      question: 'Which languages does the bot speak?',
      answer: 'Bot messages are in English by default and in Italian with /config set-language; command names stay in English. The dashboard and this website are available in English and Italian.',
    },
  },
  seo: {
    featureList: 'Five independent Discord music bots, up to five voice channels playing at once, YouTube, Spotify, SoundCloud, slash commands, dashboard with Discord sign-in, per-server bot groups',
  },
  cta: {
    title: 'More voice channels, no compromises.',
    text: 'Add the bots, sign in with Discord and configure your first server in a few minutes.',
  },
  footer: {
    about: 'Self-hosted Discord music bots. Open source fork of',
    license: '(MIT).',
    navLabel: 'Site links',
    dashboard: 'Dashboard',
    credits: 'Muse © 2026 · Made by Haxurus',
    tagline: 'discord music · self-hosted',
  },
  development: {
    kicker: 'Limited access',
    title: 'Muse is still in development.',
    text: 'For now, Muse bots can only be added to new servers by the project owner.',
    follow: 'You can follow development on GitHub, or fork the project and self-host it on your own infrastructure.',
    github: 'Project status on GitHub',
    fork: 'Fork it and self-host',
    back: 'Back to home',
  },
  pricing: {
    kicker: 'Plans',
    title: 'A plan for every server.',
    intro: 'The Free plan includes one music bot with every command and source. Paid levels add more bots in different voice channels, 24/7, higher limits and priority support.',
    betaNotice: 'Muse is in beta: online payments are not active yet. To activate a plan, contact me directly and I will set it up on your server.',
    unavailable: 'Promotions and contacts cannot be loaded right now. Please try again shortly.',
    monthly: 'Monthly',
    yearly: 'Yearly',
    billingLabel: 'Billing',
    perMonth: '/month',
    perYear: '/year',
    freeForever: 'Free forever',
    save: 'save {amount}',
    levelFree: 'FREE',
    level: 'LEVEL {level}',
    joinBeta: 'Add to Discord',
    contactMe: 'Contact me',
    promotion: 'Promotion',
    promoCode: 'code: {code}',
    promoUntil: 'until {date}',
    everyPlan: 'every plan',
    yearlyScope: 'yearly',
    monthlyScope: 'monthly',
    tierLabelFree: 'Free',
    tierLabelTier1: 'Level 1 · Plus',
    tierLabelTier2: 'Level 2 · Pro',
    tierLabelTier3: 'Level 3 · Brand',
    descFree: 'One music bot with every command: YouTube, Spotify and SoundCloud, queue, favorites and dashboard.',
    descTier1: 'Two bots in two voice channels at once, saved bot groups, longer playlists and priority support.',
    descTier2: 'All five bots in five voice channels at once, 24/7 and the highest limits.',
    descTier3: 'Everything in Level 2, plus a custom bot name and banner in your server.',
    featureBots: '{count} bots in voice at once',
    featureBot: '1 bot in voice',
    featureGroups: '{count} saved bot groups',
    featureNoGroups: 'No saved bot groups',
    featurePlaylist: '{count} tracks per playlist',
    featureFavorites: '{count} favorites',
    featureAlwaysOn: '24/7: stays in voice even alone',
    featureSupport: 'Priority support',
    featureBranding: 'Custom bot name and banner',
    compareTitle: 'Full comparison',
    compareFeature: 'Feature',
    compareCommands: 'Every command and source (YouTube, Spotify, SoundCloud)',
    compareBots: 'Bots in voice at once',
    compareGroups: 'Saved bot groups',
    comparePlaylist: 'Tracks imported per playlist',
    compareFavorites: 'Favorites per server',
    compareAlwaysOn: '24/7 (stays in an empty channel)',
    compareSupport: 'Priority support',
    compareBranding: 'Custom bot name and banner',
    included: 'Included',
    notIncluded: 'Not included',
    contactKicker: 'Contact',
    contactTitle: 'Want to activate a plan?',
    contactText: 'Write to me with your server ID and the plan you want (monthly or yearly, plus any discount code). I will reply and activate it manually.',
    contactEmail: 'Email',
    contactDiscord: 'Discord',
    contactWebsite: 'Website',
    contactGithub: 'GitHub',
    contactGithubText: 'Open an issue',
    faqTitle: 'FAQ',
    faqExpiryQuestion: 'What happens when a plan expires?',
    faqExpiryAnswer: 'The server goes back to Free: bots beyond the first stop answering and the free limits apply again. Your settings are not deleted.',
    faqBotsQuestion: 'What does “bots in voice at once” mean?',
    faqBotsAnswer: 'A Discord bot can only be in one voice channel per server. With two Muse bots you have music in two channels at the same time, with five in five, each with its own queue.',
    faqTrialQuestion: 'Can I try before paying?',
    faqTrialAnswer: 'Yes: the Free plan is always available, and during the beta I can enable trial periods.',
  },

};

export const DICTIONARIES: Readonly<Record<Locale, Messages>> = {it, en};

// A Record alias cannot reference itself, so the recursive node keeps an index signature.
// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
type DictionaryNode = {[key: string]: string | DictionaryNode};

/** Flattens a nested dictionary to the dotted keys used in the templates ("hero.line1"). */
export const flattenMessages = (node: DictionaryNode, prefix = ''): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      flat[path] = value;
    } else {
      Object.assign(flat, flattenMessages(value, path));
    }
  }

  return flat;
};

/** Template values per language, keyed by dotted path. */
export const MESSAGES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  it: flattenMessages(it),
  en: flattenMessages(en),
};

const LANGUAGE_NAMES: Record<Locale, string> = {it: 'Italiano', en: 'English'};

/**
 * Sentinel-style "IT | EN" pill. `path` is the part after the language prefix,
 * so each link points at the same page in the other language.
 */
export const languageSwitcher = (locale: Locale, path: string, variant: 'desktop' | 'mobile' = 'desktop'): string => {
  const className = variant === 'mobile' ? 'mobile-language-switcher' : 'language-switcher';
  const links = LOCALES.map(target => {
    const label = variant === 'mobile' ? `${target.toUpperCase()} · ${LANGUAGE_NAMES[target]}` : target.toUpperCase();
    const current = target === locale ? ' class="is-active" aria-current="page"' : '';
    return `<a href="${escapeHtml(localizedPath(target, path))}" lang="${target}" hreflang="${target}" data-lang-link="${target}"${current}>${escapeHtml(label)}</a>`;
  });
  return `<div class="${className}" role="group" aria-label="${escapeHtml(DICTIONARIES[locale].lang.label)}">${links.join('')}</div>`;
};

/** Renders an HTML template for one language. `path` is the page path after the prefix. */
export const renderPage = (
  template: string,
  locale: Locale,
  path: string,
  extra: Readonly<Record<string, string>> = {},
  markup: Readonly<Record<string, string>> = {},
): string => renderTemplate(
  template,
  {
    ...MESSAGES[locale],
    lang: locale,
    prefix: localizedPath(locale),
    ...extra,
  },
  {
    languageSwitcher: languageSwitcher(locale, path),
    languageSwitcherMobile: languageSwitcher(locale, path, 'mobile'),
    ...markup,
  },
);
