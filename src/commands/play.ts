import {AutocompleteInteraction, ChatInputCommandInteraction} from 'discord.js';
import {URL} from 'url';
import {SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder} from '@discordjs/builders';
import {inject, injectable, optional} from 'inversify';
import Spotify from 'spotify-web-api-node';
import Command from './index.js';
import {TYPES} from '../types.js';
import ThirdParty from '../services/third-party.js';
import getYouTubeAndSpotifySuggestionsFor, {SpotifySuggestionsUnavailableError} from '../utils/get-youtube-and-spotify-suggestions-for.js';
import KeyValueCacheProvider from '../services/key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import {toDiscordAutocompleteChoices} from '../utils/string.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';

@injectable()
export default class implements Command {
  public readonly slashCommand: Partial<SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder> & Pick<SlashCommandBuilder, 'toJSON'>;

  public requiresVC = true;

  private readonly spotify?: Spotify;
  private readonly cache: KeyValueCacheProvider;
  private readonly addQueryToQueue: AddQueryToQueue;

  constructor(@inject(TYPES.ThirdParty) @optional() thirdParty: ThirdParty, @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider, @inject(TYPES.Services.AddQueryToQueue) addQueryToQueue: AddQueryToQueue) {
    this.spotify = thirdParty?.spotify;
    this.cache = cache;
    this.addQueryToQueue = addQueryToQueue;

    const queryDescription = thirdParty === undefined
      ? 'YouTube URL or search query'
      : 'YouTube URL, Spotify URL, or search query';
    const queryDescriptionIt = thirdParty === undefined
      ? 'URL di YouTube o testo da cercare'
      : 'URL di YouTube o Spotify, o testo da cercare';

    this.slashCommand = new SlashCommandBuilder()
      .setName('play')
      .setDescription('play a song')
      .setDescriptionLocalizations({it: 'riproduci un brano'})
      .addStringOption(option => option
        .setName('query')
        .setDescription(queryDescription)
        .setDescriptionLocalizations({it: queryDescriptionIt})
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption(option => option
        .setName('immediate')
        .setDescription('add track to the front of the queue')
        .setDescriptionLocalizations({it: 'aggiungi il brano in cima alla coda'}))
      .addBooleanOption(option => option
        .setName('shuffle')
        .setDescription('shuffle the input if you\'re adding multiple tracks')
        .setDescriptionLocalizations({it: 'mescola i brani se ne aggiungi più di uno'}))
      .addBooleanOption(option => option
        .setName('split')
        .setDescription('if a track has chapters, split it')
        .setDescriptionLocalizations({it: 'se un brano ha capitoli, dividilo'}))
      .addBooleanOption(option => option
        .setName('skip')
        .setDescription('skip the currently playing track')
        .setDescriptionLocalizations({it: 'salta il brano in riproduzione'}));
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const query = interaction.options.getString('query')!;

    await this.addQueryToQueue.addToQueue({
      interaction,
      query: query.trim(),
      addToFrontOfQueue: interaction.options.getBoolean('immediate') ?? false,
      shuffleAdditions: interaction.options.getBoolean('shuffle') ?? false,
      shouldSplitChapters: interaction.options.getBoolean('split') ?? false,
      skipCurrentTrack: interaction.options.getBoolean('skip') ?? false,
    });
  }

  public async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getString('query')?.trim();

    if (!query || query.length === 0) {
      await interaction.respond([]);
      return;
    }

    let queryProtocol: string | undefined;
    try {
      queryProtocol = new URL(query).protocol;
    } catch {}

    // Don't return suggestions for supported provider URLs
    if (queryProtocol && ['http:', 'https:', 'spotify:'].includes(queryProtocol)) {
      await interaction.respond([]);
      return;
    }

    let suggestions;

    try {
      suggestions = await this.cache.wrap(
        getYouTubeAndSpotifySuggestionsFor,
        query,
        this.spotify,
        10,
        {
          expiresIn: ONE_HOUR_IN_SECONDS,
          key: `autocomplete:${query}`,
        });
    } catch (error: unknown) {
      if (error instanceof SpotifySuggestionsUnavailableError) {
        suggestions = error.suggestions;
      } else {
        throw error;
      }
    }

    await interaction.respond(toDiscordAutocompleteChoices(suggestions));
  }
}
