import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './video.entity';
import { YoutubeClient } from '@/integrations/youtube/youtube.client';
import { isoDurationToSec } from '@/common/time.util';
import { YoutubeVideo } from '@/types/youtube';
import pLimit from 'p-limit';
import { Channel } from '@/channel/channel.entity';
import { VideoAccumulators, VideoSummary } from '@/types/video';

type UpsertOpts = {
  channelId: string;
  channelSubscribers: number; // for engagement calc
};

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
    private readonly yt: YoutubeClient,
  ) {}

  /**
   * Upserts a single video row from a full Youtube `/videos` item.
   * - Computes: has_720p_plus, is_short (via HEAD redirect), engagement.
   * - Caches raw API JSON blobs to avoid re-calling the API later.
   */
  async upsertFromYoutubeItem(
    v: YoutubeVideo,
    opts: UpsertOpts,
  ): Promise<void> {
    const vid = v?.id;
    if (!vid) return;

    const snippet = v?.snippet ?? {};
    const statistics = v?.statistics ?? {};
    const contentDetails = v?.contentDetails ?? {};

    const title = snippet?.title ?? '';
    const publishedAtIso = snippet?.publishedAt ?? null;
    const publishedAt = publishedAtIso ? new Date(publishedAtIso) : new Date();

    const views = Number(statistics?.viewCount ?? 0);
    const likes =
      statistics?.likeCount != null ? Number(statistics.likeCount) : null;

    // thumbnails
    const t = snippet?.thumbnails ?? {};
    const max_w = t?.maxres?.width ?? null;
    const max_h = t?.maxres?.height ?? null;
    const high_w = t?.high?.width ?? null;
    const high_h = t?.high?.height ?? null;
    const has720 = (max_w ?? 0) >= 720 || (high_w ?? 0) >= 720 ? 1 : 0;

    // duration
    const durationSec = isoDurationToSec(contentDetails?.duration);

    // kids / category
    const toTri = (b: boolean | null | undefined): 1 | 0 | null =>
      b === true ? 1 : b === false ? 0 : null;

    const rawMfK = v?.status?.madeForKids; // boolean | undefined
    const rawSelf = v?.status?.selfDeclaredMadeForKids; // boolean | undefined

    // prefer madeForKids, fallback to selfDeclaredMadeForKids
    const mergedBool = rawMfK ?? rawSelf ?? null;
    const madeForKids: 1 | 0 | null = toTri(mergedBool);

    const categoryId = snippet?.categoryId ?? null;

    // Shorts detection by redirect
    let isShort = 0;
    try {
      const s = await this.yt.isShortByRedirect(vid);
      isShort = s === 'short' ? 1 : 0;
      if (isShort) this.logger.debug(`Detected short ${vid}`);
    } catch (e) {
      this.logger.debug(`isShortByRedirect failed for ${vid}: ${String(e)}`);
    }

    // engagement = log(views+1)/log(subscribers+1)
    const engagement = this.computeEngagement(views, opts.channelSubscribers);

    await this.videoRepo.upsert(
      {
        videoId: vid,
        channelId: opts.channelId,
        title,
        publishedAt,
        viewCount: views,
        likeCount: likes,
        durationSec,
        madeForKids,
        categoryId,

        thumb_max_w: max_w,
        thumb_max_h: max_h,
        thumb_max_url: t?.maxres?.url ?? null,
        thumb_high_w: high_w,
        thumb_high_h: high_h,
        thumb_high_url: t?.high?.url ?? null,
        has_720p_plus: has720,

        is_short: isShort,
        engagement,

        etag: v?.etag ?? null,
        api_snippet_json: JSON.stringify(snippet),
        api_statistics_json: JSON.stringify(statistics),
        api_contentDetails_json: JSON.stringify(contentDetails),
        api_full_json: JSON.stringify(v),
        fetchedAt: new Date(),
      },
      ['videoId'],
    );
  }

  private computeEngagement(views: number, subscribers: number): number | null {
    if (!subscribers || subscribers <= 0 || views < 0) return null;
    const denom = Math.log(subscribers + 1);
    return denom > 0 ? Math.log(views + 1) / denom : null;
  }

  /** Ingest a selection from DB (by statuses/limit), honoring 90d default window, no retries. */
  async runIngestFromDb(input: {
    statuses?: Array<'idle' | 'queued' | 'running' | 'done' | 'error'>;
    limit?: number;
    publishedAfter?: string;
    maxVideosPerChannel?: number;
  }): Promise<VideoSummary> {
    const { statuses, limit, publishedAfter, maxVideosPerChannel } = input;

    const qb = this.channelRepo
      .createQueryBuilder('c')
      .orderBy('c.lastIngestAt', 'ASC')
      .addOrderBy('c.id', 'ASC');

    // Debug specific id
    // qb.andWhere('c.id IN (:...ids)', { ids: ['UC9avFXTdbSo5ATvzTRnAVFg'] });

    if (statuses?.length)
      qb.andWhere('c.scrapeStatus IN (:...s)', { s: statuses });
    if (limit && limit > 0) qb.take(limit);

    const rows = await qb.getMany();
    this.logger.log(`Found ${rows.length} channels for ingest`);
    const channels = rows.map((r) => ({
      id: r.id,
      title: r.title ?? '',
      subscribers: Number(r.subscribers ?? 0),
    }));

    if (!channels.length) {
      return {
        channelsProcessed: 0,
        videosSeen: 0,
        rowsUpserted: 0,
        tookSec: 0,
      };
    }

    return this.ingestChannelsByIds(
      channels,
      publishedAfter,
      maxVideosPerChannel,
    );
  }

  private async processVideoIds(
    acc: VideoAccumulators,
    subscribers: number,
    channelId: string,
    videoIds: string[],
  ) {
    // 1) Hydrate the /videos payload once per chunk (50 ids at a time)
    const videoItems = await this.yt.getVideos(videoIds);

    // 2) Concurrency: this path does DB upserts + a single HEAD per video (shorts redirect),
    //    so we can go a bit higher than 4. 8–12 works well in practice.
    const perVideo = pLimit(10);

    await Promise.allSettled(
      (videoItems ?? []).map((v) =>
        perVideo(async () => {
          acc.videosSeen.value++;

          try {
            await this.upsertFromYoutubeItem(v, {
              channelId,
              channelSubscribers: subscribers,
            });
            acc.rowsUpserted.value++;
          } catch (err) {
            this.logger.warn(
              `Upsert failed for video ${v?.id ?? '(unknown)'} on channel ${channelId}: ${String(err)}`,
            );
          }
        }),
      ),
    );
  }

  // helper to compute publishedAfter with default 90 days and small overlap ---
  private computePublishedAfter(
    channel: { lastVideoPublishedAt: Date | null } | null,
    override?: string,
  ) {
    if (override) return override;
    const overlapMs = 5 * 60 * 1000;
    const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    if (channel?.lastVideoPublishedAt) {
      const t = channel.lastVideoPublishedAt.getTime();
      return new Date(t - overlapMs).toISOString();
    }
    return defaultFrom.toISOString();
  }

  /**
   * Ingest videos for a list of channels (pre-supplied title & subscribers)
   * - uses search.list by channelId
   * - default window is 90 days (unless override provided)
   * - no retry policy; does NOT refresh subscribers/views/videos
   */
  async ingestChannelsByIds(
    channels: Array<{ id: string; title: string; subscribers: number }>,
    publishedAfter?: string,
    maxVideosPerChannel?: number,
  ): Promise<VideoSummary> {
    const start = Date.now();
    let channelsProcessed = 0;

    // accumulators shared across the run
    const acc: VideoAccumulators = {
      videosSeen: { value: 0 },
      rowsUpserted: { value: 0 },
    };

    const channelLimit = pLimit(3);
    const chunkLimit = pLimit(6);

    const tasks: Promise<void>[] = [];

    for (const channel of channels) {
      const { id: cid, subscribers } = channel;
      tasks.push(
        channelLimit(async () => {
          const channelRow = await this.channelRepo.findOne({
            where: { id: cid },
          });
          const afterIso = this.computePublishedAfter(
            channelRow ?? null,
            publishedAfter,
          );

          if (channelRow) {
            await this.channelRepo.update(
              { id: cid },
              { scrapeStatus: 'running', scrapeError: null },
            );
          }

          try {
            const uploadsPlaylistId = channelRow?.uploadsPlaylistId;
            if (!uploadsPlaylistId) {
              this.logger.warn(
                `Missing uploadsPlaylistId for channel ${cid}, skipping.`,
              );
              return;
            }

            const { videoIds: collectedVideoIds, mostRecentPublishedAt } =
              await this.yt.listUploadsSince(uploadsPlaylistId, {
                publishedAfterIso: afterIso,
                maxVideos: maxVideosPerChannel,
              });

            // hydrate & persist
            const chunkSize = 50;
            const chunkTasks: Promise<void>[] = [];
            for (let i = 0; i < collectedVideoIds.length; i += chunkSize) {
              const chunk = collectedVideoIds.slice(i, i + chunkSize);
              chunkTasks.push(
                chunkLimit(() =>
                  this.processVideoIds(acc, subscribers, cid, chunk),
                ),
              );
            }
            await Promise.allSettled(chunkTasks);

            const markers: Partial<Channel> = {
              lastIngestAt: new Date(),
            };
            if (mostRecentPublishedAt)
              markers.lastVideoPublishedAt = new Date(mostRecentPublishedAt);

            if (channelRow) {
              await this.channelRepo.update(
                { id: cid },
                { ...markers, scrapeStatus: 'done' },
              );
            }

            channelsProcessed++;
          } catch (e) {
            if (channelRow) {
              await this.channelRepo.update(
                { id: cid },
                { scrapeStatus: 'error', scrapeError: String(e) },
              );
            }
            this.logger.error(`Ingest failed for channel ${cid}: ${String(e)}`);
          }
        }),
      );
    }

    await Promise.allSettled(tasks);

    const took = Math.round((Date.now() - start) / 1000);
    const summary: VideoSummary = {
      channelsProcessed,
      videosSeen: acc.videosSeen.value,
      rowsUpserted: acc.rowsUpserted.value,
      tookSec: took,
    };
    this.logger.log(
      `Channel-ingest summary: ${JSON.stringify(summary, null, 2)}`,
    );
    return summary;
  }
}
