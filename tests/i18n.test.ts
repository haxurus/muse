import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {HttpError} from '../src/control/http.js';
import {sanitizeGuildSettingsPatch} from '../src/control/settings-validation.js';
import {BLOCKED_USER_MESSAGE, blockedUserMessage} from '../src/control/blocklist.js';
import {EN_MESSAGES, type MessageKey} from '../src/i18n/en.js';
import {IT_MESSAGES} from '../src/i18n/it.js';
import {
  DEFAULT_LOCALE,
  UserError,
  isLocale,
  localeFromDiscord,
  localeOf,
  localizeEnglishMessage,
  localizeError,
  normalizeLocale,
  t,
} from '../src/i18n/index.js';
import errorMsg from '../src/utils/error-msg.js';
import {PLAYBACK_OUTCOME_UNKNOWN_MESSAGE} from '../src/playback/protocol.js';

const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

describe('t()', () => {
  it('defaults to English and interpolates variables', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(t('en', 'volumeDone', {level: 42})).toBe('Set volume to 42%');
    expect(t('it', 'volumeDone', {level: 42})).toBe('Volume impostato al 42%');
    expect(t('en', 'moveDone', {title: 'Song', position: 3})).toBe('moved **Song** to position **3**');
  });

  it('falls back to English for unknown, missing or differently cased locales', () => {
    for (const locale of ['fr', 'IT', '', null, undefined]) {
      expect(t(locale, 'shuffleDone')).toBe('shuffled');
    }
  });

  it('leaves unknown placeholders untouched and never re-expands inserted values', () => {
    expect(t('en', 'volumeDone')).toBe('Set volume to {level}%');
    expect(t('en', 'moveDone', {title: '{position} $& $1', position: 2})).toBe('moved **{position} $& $1** to position **2**');
  });

  it('normalizes locale values', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('it')).toBe(true);
    expect(isLocale('IT')).toBe(false);
    expect(isLocale(1)).toBe(false);
    expect(normalizeLocale('fr')).toBe('en');
    expect(localeOf(undefined)).toBe('en');
    expect(localeOf({})).toBe('en');
    expect(localeOf({locale: 'it'})).toBe('it');
    expect(localeFromDiscord('it')).toBe('it');
    expect(localeFromDiscord('en-US')).toBe('en');
    expect(localeFromDiscord(undefined)).toBe('en');
  });
});

describe('dictionaries', () => {
  it('give Italian exactly the English keys, with the same placeholders', () => {
    const englishKeys = Object.keys(EN_MESSAGES).sort();
    expect(Object.keys(IT_MESSAGES).sort()).toEqual(englishKeys);

    for (const key of englishKeys as MessageKey[]) {
      expect(IT_MESSAGES[key].trim(), key).not.toBe('');
      expect(placeholders(IT_MESSAGES[key]), key).toEqual(placeholders(EN_MESSAGES[key]));
    }
  });

  it('keeps playback relay messages within the transport pass-through limit', () => {
    for (const key of Object.keys(IT_MESSAGES).filter(key => key.startsWith('playback')) as MessageKey[]) {
      expect(IT_MESSAGES[key].length, key).toBeLessThanOrEqual(200);
    }
  });
});

describe('error localization', () => {
  it('keeps the English message on UserError and localizes on demand', () => {
    const error = new UserError('configInvalidLimit', {max: 500});
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('invalid limit, must be between 1 and 500');
    expect(error.localize('it')).toBe('limite non valido, deve essere tra 1 e 500');
    expect(localizeError('it', error)).toBe('limite non valido, deve essere tra 1 e 500');
  });

  it('translates fixed English messages from plain errors and relays', () => {
    expect(localizeEnglishMessage('it', 'Move index is outside the range of the queue.')).toBe('La posizione è fuori dalla coda.');
    expect(localizeEnglishMessage('it', PLAYBACK_OUTCOME_UNKNOWN_MESSAGE)).toBe(IT_MESSAGES.playbackOutcomeUnknown);
    expect(localizeEnglishMessage('en', 'Move index is outside the range of the queue.')).toBe('Move index is outside the range of the queue.');
    expect(localizeEnglishMessage('it', 'some other detail')).toBe('some other detail');
    expect(localizeError('it', new Error('no songs found'))).toBe('nessun brano trovato');
  });

  it('formats user errors with a localized prefix', () => {
    expect(errorMsg('boom')).toBe('🚫 ope: boom');
    expect(errorMsg(new UserError('nothingIsPlaying'), 'it')).toBe('🚫 ops: non c\'è niente in riproduzione');
    expect(errorMsg(undefined, 'it')).toBe('errore sconosciuto');
  });

  it('localizes the blocked-user refusal', () => {
    expect(BLOCKED_USER_MESSAGE).toBe('You can\'t use this bot.');
    expect(blockedUserMessage('en')).toBe('You can\'t use this bot.');
    expect(blockedUserMessage('it')).toBe('Non puoi usare questo bot.');
  });
});

describe('locale guild setting', () => {
  it.each(['en', 'it'])('accepts locale %s', locale => {
    expect(sanitizeGuildSettingsPatch({locale})).toEqual({locale});
  });

  it('accepts locale together with other settings', () => {
    expect(sanitizeGuildSettingsPatch({locale: 'it', defaultVolume: 50})).toEqual({locale: 'it', defaultVolume: 50});
  });

  it.each([
    {locale: 'fr'},
    {locale: 'IT'},
    {locale: 'En'},
    {locale: ''},
    {locale: 1},
    {locale: null},
    {locale: true},
    {locale: ['it']},
    {locale: {value: 'it'}},
  ])('rejects %o', patch => {
    expect(() => sanitizeGuildSettingsPatch(patch)).toThrowError(HttpError);
  });

  it('defaults new guild rows to English in the schema', async () => {
    const schema = await readFile(new URL('../schema.prisma', import.meta.url), 'utf8');
    expect(schema).toMatch(/model Setting \{[^}]*\n\s+locale\s+String\s+@default\("en"\)/);
  });

  it('ships a migration that adds the column with an English default', async () => {
    const sql = await readFile(new URL('../migrations/20261006120000_add_guild_locale/migration.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ALTER TABLE "Setting" ADD COLUMN "locale" TEXT NOT NULL DEFAULT \'en\';');
  });
});
