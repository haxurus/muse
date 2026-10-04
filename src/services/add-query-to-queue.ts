import {ChatInputCommandInteraction, GuildMember, VoiceChannel} from 'discord.js';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import {MediaSource, SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {SponsorBlock} from 'sponsorblock-api';
import Config from './config.js';
import KeyValueCacheProvider from './key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';

const isSameQueueEntry = (capturedId: number | null, currentId: number | null) => (
  capturedId !== null && capturedId === currentId
);

export type QueueAddRequest = {
  guildId: string;
  targetVoiceChannel: VoiceChannel;
  textChannelId: string;
  requesterId: string;
  query: string;
  addToFrontOfQueue: boolean;
  shuffleAdditions: boolean;
  shouldSplitChapters: boolean;
  skipCurrentTrack: boolean;
};

export type QueueAddResult = {
  message: string;
  currentSong: SongMetadata | null;
  queueSize: number;
  status: STATUS;
  voiceChannelId: string | null;
  showPlayingEmbed: boolean;
};

const normalizeSkipError = (error: unknown) => (
  error instanceof Error && error.message === 'No songs in queue to forward to.'
    ? new Error('no song to skip to')
    : error
);

@injectable()
export default class AddQueryToQueue {
  private readonly sponsorBlock?: SponsorBlock;
  private sponsorBlockDisabledUntil?: Date;
  private readonly sponsorBlockTimeoutDelay;
  private readonly cache: KeyValueCacheProvider;

  constructor(@inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs,
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Config) private readonly config: Config,
    @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider) {
    this.sponsorBlockTimeoutDelay = config.SPONSORBLOCK_TIMEOUT;
    this.sponsorBlock = config.ENABLE_SPONSORBLOCK
      ? new SponsorBlock('muse-sb-integration') // UserID matters only for submissions
      : undefined;
    this.cache = cache;
  }

  public async addToQueue({
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    skipCurrentTrack,
    interaction,
  }: {
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    skipCurrentTrack: boolean;
    interaction: ChatInputCommandInteraction;
  }): Promise<void> {
    const guildId = interaction.guild!.id;
    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);
    const {queueAddResponseEphemeral} = await getGuildSettings(guildId);

    await interaction.deferReply({ephemeral: queueAddResponseEphemeral});

    const result = await this.addRequest({
      guildId,
      targetVoiceChannel,
      textChannelId: interaction.channel!.id,
      requesterId: interaction.member!.user.id,
      query: query.trim(),
      addToFrontOfQueue,
      shuffleAdditions,
      shouldSplitChapters,
      skipCurrentTrack,
    });

    const player = this.playerManager.get(guildId);
    if (result.showPlayingEmbed && player.getCurrent()) {
      await interaction.editReply({
        embeds: [buildPlayingMessageEmbed(player)],
      });
    }

    await interaction.editReply(result.message);
  }

  public async addRequest({
    guildId,
    targetVoiceChannel,
    textChannelId,
    requesterId,
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    skipCurrentTrack,
  }: QueueAddRequest): Promise<QueueAddResult> {
    const player = this.playerManager.get(guildId);
    const currentQueueEntryId = player.getCurrentQueueEntryId();
    const wasPlayingSong = currentQueueEntryId !== null;
    const {playlistLimit} = await getGuildSettings(guildId);

    let [newSongs, extraMsg] = await this.getSongs.getSongs(query, playlistLimit, shouldSplitChapters);

    if (newSongs.length === 0) {
      throw new Error('no songs found');
    }

    if (shuffleAdditions) {
      newSongs = shuffle(newSongs);
    }

    if (this.config.ENABLE_SPONSORBLOCK) {
      newSongs = await Promise.all(newSongs.map(this.skipNonMusicSegments.bind(this)));
    }

    const needsConnection = player.voiceConnection === null;
    if (needsConnection) {
      await player.connect(targetVoiceChannel);
    } else {
      const connectedChannelId = player.voiceConnection.joinConfig.channelId;
      if (connectedChannelId !== targetVoiceChannel.id) {
        throw new Error('this music bot is already assigned to another voice channel');
      }

      await player.ensureVoiceConnectionReady();
    }

    newSongs.forEach((song, index) => {
      player.add({
        ...song,
        addedInChannelId: textChannelId,
        requestedBy: requesterId,
      }, {
        immediate: addToFrontOfQueue,
        immediateOffset: index,
      });
    });

    const firstSong = newSongs[0];
    let statusMsg = '';

    if (needsConnection) {
      await player.play();

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }
    } else if (player.status === STATUS.IDLE) {
      await player.play();
    }

    if (!player.getCurrent()) {
      throw new Error('no playable songs found');
    }

    let didSkipCurrentTrack = false;
    if (skipCurrentTrack && isSameQueueEntry(currentQueueEntryId, player.getCurrentQueueEntryId())) {
      try {
        await player.forward(1);
        didSkipCurrentTrack = true;
      } catch (error: unknown) {
        throw normalizeSkipError(error);
      }
    }

    if (statusMsg !== '') {
      if (extraMsg === '') {
        extraMsg = statusMsg;
      } else {
        extraMsg = `${statusMsg}, ${extraMsg}`;
      }
    }

    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    const message = newSongs.length === 1
      ? `u betcha, **${firstSong.title}** added to the${addToFrontOfQueue ? ' front of the' : ''} queue${didSkipCurrentTrack ? ' and current track skipped' : ''}${extraMsg}`
      : `u betcha, **${firstSong.title}** and ${newSongs.length - 1} other songs were added to the queue${didSkipCurrentTrack ? ' and current track skipped' : ''}${extraMsg}`;

    return {
      message,
      currentSong: player.getCurrent(),
      queueSize: player.queueSize(),
      status: player.status,
      voiceChannelId: player.voiceConnection?.joinConfig.channelId ?? null,
      showPlayingEmbed: needsConnection,
    };
  }

  private async skipNonMusicSegments(song: SongMetadata) {
    if (!this.sponsorBlock
          || (this.sponsorBlockDisabledUntil && new Date() < this.sponsorBlockDisabledUntil)
          || song.source !== MediaSource.Youtube
          || !song.url) {
      return song;
    }

    try {
      const segments = await this.cache.wrap(
        async () => this.sponsorBlock?.getSegments(song.url, ['music_offtopic']),
        {
          key: song.url, // Value is too short for hashing
          expiresIn: ONE_HOUR_IN_SECONDS,
        },
      ) ?? [];
      const originalStart = song.offset;
      const originalEnd = song.offset + song.length;
      const skipSegments = segments
        .filter(({startTime, endTime}) => endTime > originalStart && startTime < originalEnd)
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((acc: Array<{startTime: number; endTime: number}>, {startTime, endTime}) => {
          const previousSegment = acc[acc.length - 1];
          // If segments overlap merge
          if (previousSegment && previousSegment.endTime > startTime) {
            acc[acc.length - 1].endTime = Math.max(previousSegment.endTime, endTime);
          } else {
            acc.push({startTime, endTime});
          }

          return acc;
        }, []);

      const intro = skipSegments[0];
      const outro = skipSegments.at(-1);
      // SponsorBlock timestamps refer to the full source, including when this
      // queue entry is only a chapter. Clamp both trims to that entry's interval.
      const start = intro && intro.startTime <= originalStart + 2
        ? Math.min(originalEnd, Math.max(originalStart, Math.floor(intro.endTime)))
        : originalStart;
      const end = outro && outro.endTime >= originalEnd - 2
        ? Math.max(start, Math.min(originalEnd, outro.startTime))
        : originalEnd;
      song.offset = start;
      song.length = Math.max(0, end - start);

      return song;
    } catch (e) {
      if (!(e instanceof Error)) {
        console.error('Unexpected event occurred while fetching skip segments : ', e);
        return song;
      }

      if (!e.message.includes('404')) {
        // Don't log 404 response, it just means that there are no segments for given video
        console.warn(`Could not fetch skip segments for "${song.url}" :`, e);
      }

      if (e.message.includes('504')) {
        // Stop fetching SponsorBlock data when servers are down
        this.sponsorBlockDisabledUntil = new Date(new Date().getTime() + (this.sponsorBlockTimeoutDelay * 60_000));
      }

      return song;
    }
  }
}
