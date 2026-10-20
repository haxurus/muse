import type {Setting} from '@prisma/client';
import {prisma} from '../utils/db.js';
import type {WorkerFavoriteExport} from './types.js';

/**
 * Settings row and saved favorites of one guild on this bot. The settings row is read, not
 * created, so an export never writes to the database.
 */
export const exportGuildData = async (guildId: string): Promise<{settings: Setting | null; favorites: WorkerFavoriteExport[]}> => {
  const [settings, favorites] = await Promise.all([
    prisma.setting.findUnique({where: {guildId}}),
    prisma.favoriteQuery.findMany({
      where: {guildId},
      orderBy: {id: 'asc'},
      select: {name: true, query: true, authorId: true, createdAt: true},
    }),
  ]);

  return {
    settings,
    favorites: favorites.map(favorite => ({
      name: favorite.name,
      query: favorite.query,
      authorId: favorite.authorId,
      createdAt: favorite.createdAt.toISOString(),
    })),
  };
};

/** Deletes the favorites a user authored, in one guild or (without `guildId`) in every guild of this bot's database. */
export const deleteFavoritesOfUser = async (userId: string, guildId?: string): Promise<number> => {
  const result = await prisma.favoriteQuery.deleteMany({
    where: {
      authorId: userId,
      ...(guildId === undefined ? {} : {guildId}),
    },
  });

  return result.count;
};
