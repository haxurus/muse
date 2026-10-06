import getYouTubeID from 'get-youtube-id';
import {EmbedBuilder} from 'discord.js';
import Player, {MediaSource, QueuedSong, STATUS} from '../services/player.js';
import getProgressBar from './get-progress-bar.js';
import {prettyTime} from './time.js';
import {truncate} from './string.js';
import {DEFAULT_LOCALE, UserError, t, type Locale} from '../i18n/index.js';

const getMaxSongTitleLength = (title: string) => {
  // eslint-disable-next-line no-control-regex
  const nonASCII = /[^\x00-\x7F]+/;
  return nonASCII.test(title) ? 28 : 48;
};

const getSongTitle = ({title, url, offset, source}: QueuedSong, shouldTruncate = false) => {
  if (source === MediaSource.HLS) {
    // Direct stream titles are the (unbounded) URL itself; keep embeds within Discord limits.
    const streamTitle = truncate(title, shouldTruncate ? getMaxSongTitleLength(title) : 256);
    return url.length > 1024 ? streamTitle : `[${streamTitle}](${url})`;
  }

  const cleanSongTitle = title.replace(/\[.*\]/, '').trim();

  const songTitle = shouldTruncate ? truncate(cleanSongTitle, getMaxSongTitleLength(cleanSongTitle)) : cleanSongTitle;
  if (source === MediaSource.SoundCloud) {
    const soundCloudTitle = truncate(songTitle, 256);
    // Keep long share parameters in the playable URL without overflowing Discord embeds.
    return url.length > 1024 ? soundCloudTitle : `[${soundCloudTitle}](${url})`;
  }

  const youtubeId = url.length === 11 ? url : getYouTubeID(url) ?? '';

  return `[${songTitle}](https://www.youtube.com/watch?v=${youtubeId}${offset === 0 ? '' : '&t=' + String(offset)})`;
};

const getQueueInfo = (player: Player, locale: Locale) => {
  const queueSize = player.queueSize();
  if (queueSize === 0) {
    return '-';
  }

  return queueSize === 1 ? t(locale, 'embedOneSong') : t(locale, 'embedSongs', {count: queueSize});
};

const getPlayerUI = (player: Player, locale: Locale) => {
  const song = player.getCurrent();

  if (!song) {
    return '';
  }

  const position = player.getPosition();
  const button = player.status === STATUS.PLAYING ? '⏹️' : '▶️';
  const progressBar = getProgressBar(10, position / song.length);
  const elapsedTime = song.isLive ? t(locale, 'embedLive') : `${prettyTime(position)}/${prettyTime(song.length)}`;
  const loop = player.loopCurrentSong ? '🔂' : player.loopCurrentQueue ? '🔁' : '';
  const vol: string = typeof player.getVolume() === 'number' ? `${player.getVolume()!}%` : '';
  return `${button} ${progressBar} \`[${elapsedTime}]\`🔉 ${vol} ${loop}`;
};

export const buildPlayingMessageEmbed = (player: Player, locale: Locale = DEFAULT_LOCALE): EmbedBuilder => {
  const currentlyPlaying = player.getCurrent();

  if (!currentlyPlaying) {
    throw new Error('No playing song found');
  }

  const {artist, thumbnailUrl, requestedBy} = currentlyPlaying;
  const message = new EmbedBuilder();
  message
    .setColor(player.status === STATUS.PLAYING ? 'DarkGreen' : 'DarkRed')
    .setTitle(player.status === STATUS.PLAYING ? t(locale, 'embedNowPlaying') : t(locale, 'embedPaused'))
    .setDescription(`
      **${getSongTitle(currentlyPlaying)}**
      ${t(locale, 'embedRequestedBy', {user: requestedBy})}\n
      ${getPlayerUI(player, locale)}
    `)
    .setFooter({text: t(locale, 'embedSource', {artist})});

  if (thumbnailUrl) {
    message.setThumbnail(thumbnailUrl);
  }

  return message;
};

export const buildQueueEmbed = (player: Player, page: number, pageSize: number, locale: Locale = DEFAULT_LOCALE): EmbedBuilder => {
  if (page < 1) {
    throw new UserError('embedPageAtLeastOne');
  }

  const currentlyPlaying = player.getCurrent();

  if (!currentlyPlaying) {
    throw new UserError('embedQueueEmpty');
  }

  const queueSize = player.queueSize();
  const maxQueuePage = Math.max(1, Math.ceil(queueSize / pageSize));

  if (page > maxQueuePage) {
    throw new UserError('embedQueueTooSmall');
  }

  const queuePageBegin = (page - 1) * pageSize;
  const queuePageEnd = queuePageBegin + pageSize;
  const queuedSongs = player
    .getQueue()
    .slice(queuePageBegin, queuePageEnd)
    .map((song, index) => {
      const songNumber = index + 1 + queuePageBegin;
      const duration = song.isLive ? t(locale, 'embedLive') : prettyTime(song.length);

      return `\`${songNumber}.\` ${getSongTitle(song, true)} \`[${duration}]\``;
    });

  const {artist, thumbnailUrl, playlist, requestedBy} = currentlyPlaying;
  const playlistTitle = playlist ? `(${playlist.title})` : '';
  const totalLength = player.getQueue().reduce((accumulator, current) => accumulator + current.length, 0);

  const message = new EmbedBuilder();

  let description = `**${getSongTitle(currentlyPlaying)}**\n`;
  description += `${t(locale, 'embedRequestedBy', {user: requestedBy})}\n\n`;
  description += `${getPlayerUI(player, locale)}\n\n`;

  if (player.getQueue().length > 0) {
    description += `${t(locale, 'embedUpNext')}\n`;
    for (const [index, song] of queuedSongs.entries()) {
      // Leave room for a useful hint instead of rejecting the entire /queue response.
      const overflowMessage = t(locale, 'embedOverflow', {count: queuedSongs.length - index});
      if (description.length + song.length + 1 + overflowMessage.length > 4096) {
        description += overflowMessage;
        break;
      }

      description += `${song}\n`;
    }
  }

  message
    .setTitle(player.status === STATUS.PLAYING
      ? `${t(locale, 'embedNowPlaying')} ${player.loopCurrentSong ? t(locale, 'embedLoopOn') : ''}`
      : t(locale, 'embedQueuedSongs'))
    .setColor(player.status === STATUS.PLAYING ? 'DarkGreen' : 'NotQuiteBlack')
    .setDescription(description)
    .addFields([{name: t(locale, 'embedInQueue'), value: getQueueInfo(player, locale), inline: true}, {
      name: t(locale, 'embedTotalLength'), value: `${totalLength > 0 ? prettyTime(totalLength) : '-'}`, inline: true,
    }, {name: t(locale, 'embedPage'), value: t(locale, 'embedPageOf', {page, total: maxQueuePage}), inline: true}])
    .setFooter({text: `${t(locale, 'embedSource', {artist})} ${playlistTitle}`});

  if (thumbnailUrl) {
    message.setThumbnail(thumbnailUrl);
  }

  return message;
};
