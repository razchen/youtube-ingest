import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from './channel.entity';
import { Thumbnail } from './thumbnail.entity';
import {
  ensureDir,
  downloadToFile,
  imageMeta,
  writeCsv,
  writeJsonl,
} from '../common/fs.util';
import { sha256Buffer, pHash, assignSplit } from '../common/hash.util';
import { isoDurationToSec } from '../common/time.util';
import { ocrBasic } from '../common/ocr.util';
import { analyzeImage } from '../common/vision.util';
import { refineVision } from '../common/vision-post.util';

import * as path from 'path';
import * as fs from 'fs';
import pLimit from 'p-limit';
import { YoutubeClient } from './youtube.client';
import { IngestSummary } from '@/types/ingest';

type IngestParams = {
  channelIds?: string[];
  channelHandles?: string[];
  queries?: string[];
  publishedAfter?: string;
  maxVideosPerChannel?: number;
};

type IngestAccumulators = {
  videosSeen: { value: number };
  imagesSaved: { value: number };
  rowsUpserted: { value: number };
  jsonlRecords: any[];
  csvRows: any[][];
};

interface CSVThumbnail extends Thumbnail {
  channelTitle: string;
  subscribers: number;
}

@Injectable()
export class YoutubeIngestService {
  private readonly logger = new Logger(YoutubeIngestService.name);
  private readonly dataDir: string;

  constructor(
    private readonly cfg: ConfigService,
    private readonly yt: YoutubeClient,
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>, // NEW
    @InjectRepository(Thumbnail) private readonly repo: Repository<Thumbnail>,
  ) {
    this.dataDir = this.cfg.get('DATA_DIR', './data');
    ensureDir(this.imageDir());
    ensureDir(this.metaDir());
  }

  private imageDir() {
    return path.resolve(this.dataDir, 'images');
  }
  private metaDir() {
    return path.resolve(this.dataDir, 'meta');
  }

  /** Normalize to '@handle' */
  private normHandle(h: string) {
    const s = (h || '').trim();
    if (!s) return s;
    return s.startsWith('@') ? s : `@${s}`;
  }

  /** Discover channels from handles: resolve + upsert into channels. Returns resolved channelIds. */
  async discoverChannelsFromHandles(handles: string[]): Promise<{
    resolvedIds: string[];
    notFound: string[];
    errors: { handle: string; error: string }[];
  }> {
    const input = Array.from(
      new Set(handles.map((h) => this.normHandle(h)).filter(Boolean)),
    );

    const resolvedIds: string[] = [];
    const notFound: string[] = [];
    const errors: { handle: string; error: string }[] = [];

    for (const h of input) {
      try {
        // cheap, 1-unit call:
        const item = await this.yt.getChannelByHandle(h);
        if (!item?.id) {
          notFound.push(h);
          continue;
        }
        // upsert minimal channel row
        await this.channelRepo
          .createQueryBuilder()
          .insert()
          .into(Channel)
          .values({
            id: item.id,
            handle: h,
            title: item?.snippet?.title ?? '',
            subscribers: Number(item?.statistics?.subscriberCount ?? 0),
            viewsCount:
              item?.statistics?.viewCount != null
                ? Number(item.statistics.viewCount)
                : null,
            videosCount:
              item?.statistics?.videoCount != null
                ? Number(item.statistics.videoCount)
                : null,
            uploadsPlaylistId:
              item?.contentDetails?.relatedPlaylists?.uploads ?? null,
            country: item?.snippet?.country ?? null,
            etag: (item as any)?.etag ?? null,
            // leave scrapeStatus/markers as defaults
          })
          .orUpdate(
            [
              'handle',
              'title',
              'subscribers',
              'viewsCount',
              'videosCount',
              'uploadsPlaylistId',
              'country',
              'etag',
            ],
            ['id'],
          )
          .execute();

        resolvedIds.push(item.id);
      } catch (e: any) {
        errors.push({ handle: h, error: String(e?.message ?? e) });
        this.logger.warn(`discover failed for ${h}: ${String(e)}`);
      }
    }

    return { resolvedIds, notFound, errors };
  }

  /** Ingest a selection from DB (by statuses/limit), honoring 90d default window, no retries. */
  async runIngestFromDb(input: {
    statuses?: Array<'idle' | 'queued' | 'running' | 'done' | 'error'>;
    limit?: number;
    publishedAfter?: string;
    maxVideosPerChannel?: number;
  }): Promise<IngestSummary> {
    const { statuses, limit, publishedAfter, maxVideosPerChannel } = input;
    const qb = this.channelRepo
      .createQueryBuilder('c')
      .orderBy('c.lastIngestAt', 'ASC', 'NULLS FIRST')
      .addOrderBy('c.id', 'ASC');

    if (statuses?.length)
      qb.andWhere('c.scrapeStatus IN (:...s)', { s: statuses });
    if (limit && limit > 0) qb.take(limit);

    const rows = await qb.getMany();
    const ids = rows.map((r) => r.id);
    if (!ids.length) {
      return {
        channelsProcessed: 0,
        videosSeen: 0,
        imagesSaved: 0,
        rowsUpserted: 0,
        tookSec: 0,
        jsonlPath: path.join(this.metaDir(), 'records.jsonl'),
        csvPath: path.join(this.metaDir(), 'records.csv'),
        imageDir: this.imageDir(),
      };
    }

    return this.ingestChannelsByIds({
      channelIds: ids,
      publishedAfter,
      maxVideosPerChannel,
    });
  }

  private async processVideoIds(
    acc: IngestAccumulators,
    subscribers: number,
    channelTitle: string,
    channelId: string,
    videoIds: string[],
  ) {
    const videoItems = await this.yt.getVideos(videoIds);

    const perVideo = pLimit(4);
    await Promise.allSettled(
      (videoItems ?? []).map((v) =>
        perVideo(async () => {
          acc.videosSeen.value++;
          const vid = v?.id;
          if (!vid) return;

          const snippet = v?.snippet ?? {};
          const statistics = v?.statistics ?? {};
          const contentDetails = v?.contentDetails ?? {};
          const live = v?.liveStreamingDetails ?? {};

          const title: string = snippet?.title ?? '';
          this.logger.log(title);

          // choose thumbnail
          const t = snippet?.thumbnails ?? {};
          const chosen = t.maxres ?? t.high ?? t.medium ?? null;
          const src = chosen?.url;
          if (!src) {
            this.logger.warn(`No viable thumbnail for video ${vid}, skipping.`);
            return;
          }

          const savePath = path.join(this.imageDir(), `${vid}.jpg`);
          if (!fs.existsSync(savePath)) {
            try {
              await downloadToFile(src, savePath);
              acc.imagesSaved.value++;
            } catch (e) {
              this.logger.warn(
                `Failed to download thumbnail ${src} -> ${savePath}: ${String(e)}`,
              );
              return;
            }
          }

          // compute hashes + OCR
          const buf = await fs.promises.readFile(savePath);
          const sha = sha256Buffer(buf);
          const ph = await pHash(savePath);

          const nativeW =
            chosen?.width ?? (await imageMeta(savePath)).width ?? null;
          const nativeH =
            chosen?.height ?? (await imageMeta(savePath)).height ?? null;

          const ocr = await ocrBasic(savePath);

          const visionRaw = await analyzeImage(savePath, {
            title,
            ocrText: (ocr as any)?.rawText ?? '',
          });

          const refined = refineVision(visionRaw, {
            title,
            ocrText: (ocr as any)?.rawText ?? '',
          });

          const faces_json = refined.faces_json;
          const objects_json = refined.objects_json;
          const palette_json = refined.palette_json;
          const contrast = refined.contrast ?? null;

          const publishedAt: string = snippet?.publishedAt ?? '';
          const views = Number(statistics?.viewCount ?? 0);
          const likes =
            statistics?.likeCount != null ? Number(statistics.likeCount) : null;
          const durationSec = isoDurationToSec(contentDetails?.duration);
          const isLive =
            live?.actualStartTime || live?.scheduledStartTime ? 1 : null;
          const madeForKids =
            snippet?.madeForKids === true
              ? 1
              : snippet?.madeForKids === false
                ? 0
                : null;
          const categoryId = snippet?.categoryId ?? null;
          const fetchedAt = new Date().toISOString();

          // engagementScore = log(views)/log(subscribers+1)
          let engagementScore: number | null = null;
          if (subscribers && subscribers > 0 && views >= 0) {
            const denom = Math.log(subscribers + 1);
            engagementScore = denom > 0 ? Math.log(views + 1) / denom : null;
          }

          const split = assignSplit(channelId);

          const row: Partial<Thumbnail> = {
            videoId: vid,
            channelId,
            title,
            publishedAt,
            views,
            likes,
            thumbnail_savedPath: savePath,
            thumbnail_src: src,
            thumbnail_nativeW: nativeW,
            thumbnail_nativeH: nativeH,
            ocr_charCount: ocr.charCount,
            ocr_areaPct: ocr.areaPct,
            engagementScore,
            hash_pHash: ph,
            hash_sha256: sha,
            split,
            fetchedAt,
            categoryId,
            tags_json: null,
            durationSec,
            isLive,
            madeForKids,
            faces_json,
            objects_json,
            palette_json,
            contrast,
            entropy: null,
            saliency_json: null,
            flags_json: null,
            etag: v?.etag ?? null,
            notes: null,
          };

          await this.repo.upsert(row as CSVThumbnail, ['videoId']);
          acc.rowsUpserted.value++;

          acc.jsonlRecords.push(row);
          acc.csvRows.push([
            row.videoId,
            row.channelId,
            channelTitle,
            row.title,
            row.publishedAt,
            row.views,
            row.likes,
            subscribers,
            row.thumbnail_savedPath,
            row.thumbnail_src,
            row.thumbnail_nativeW,
            row.thumbnail_nativeH,
            row.ocr_charCount,
            row.ocr_areaPct,
            row.engagementScore,
            row.hash_pHash,
            row.hash_sha256,
            row.split,
            row.fetchedAt,
            refined.csv.faces_count,
            refined.csv.faces_largest_areaPct,
            refined.contrast ?? null,
            refined.csv.palette_top1,
            refined.csv.tags,
          ]);
        }),
      ),
    );
  }

  // helper to compute publishedAfter with default 90 days and small overlap ---
  private computePublishedAfter(
    channel: { lastVideoPublishedAt: string | null } | null,
    overrideAfter?: string,
  ): string {
    if (overrideAfter) return overrideAfter; // trust caller-provided window

    const overlapMs = 5 * 60 * 1000; // 5 min overlap for safety
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const defaultFrom = new Date(now - ninetyDaysMs);

    if (channel?.lastVideoPublishedAt) {
      const t = new Date(channel.lastVideoPublishedAt).getTime();
      const d = new Date(Math.max(0, t - overlapMs));
      return d.toISOString();
    }
    return defaultFrom.toISOString();
  }

  /**
   * NEW: Ingest videos for a list of channel IDs (UC…)
   * - uses search.list by channelId (NOT playlistItems)
   * - default window is 90 days (unless override provided)
   * - no retry policy; failures set channel status to 'error'
   * - does NOT refresh subscribers/views/videos (those are discovery-only)
   */
  async ingestChannelsByIds(input: {
    channelIds: string[];
    publishedAfter?: string; // optional override (ISO)
    maxVideosPerChannel?: number; // optional soft cap
  }): Promise<IngestSummary> {
    const { channelIds, publishedAfter, maxVideosPerChannel } = input;

    const start = Date.now();
    let channelsProcessed = 0;

    // accumulators shared across the run
    const acc: IngestAccumulators = {
      videosSeen: { value: 0 },
      imagesSaved: { value: 0 },
      rowsUpserted: { value: 0 },
      jsonlRecords: [],
      csvRows: [],
    };

    const csvHeaders = [
      'videoId',
      'channelId',
      'channelTitle',
      'title',
      'publishedAt',
      'views',
      'likes',
      'subscribers',
      'thumbnail_savedPath',
      'thumbnail_src',
      'thumbnail_nativeW',
      'thumbnail_nativeH',
      'ocr_charCount',
      'ocr_areaPct',
      'engagementScore',
      'hash_pHash',
      'hash_sha256',
      'split',
      'fetchedAt',
      'faces_count',
      'faces_largest_areaPct',
      'contrast',
      'palette_top1',
      'tags',
    ];

    const channelLimit = pLimit(3);
    const chunkLimit = pLimit(6);

    const tasks: Promise<void>[] = [];

    for (const cid of new Set(channelIds)) {
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
            const ch = await this.yt.getChannel(cid);
            const item = ch?.items?.[0];
            if (!item) {
              this.logger.warn(`Channel not found: ${cid}`);
              if (channelRow)
                await this.channelRepo.update(
                  { id: cid },
                  { scrapeStatus: 'error', scrapeError: 'not_found' },
                );
              return;
            }
            const subscribers = Number(item?.statistics?.subscriberCount ?? 0);
            const channelTitle = item?.snippet?.title ?? '';

            let pageToken: string | undefined;
            let collectedVideoIds: string[] = [];
            let mostRecentPublishedAt: string | null = null;

            do {
              const res = await this.yt.searchChannelUploads(
                cid,
                afterIso,
                pageToken,
              );
              const items: any[] = res?.items ?? [];
              const vids = items
                .map((it: any) => {
                  const vid = it?.id?.videoId;
                  const pa = it?.snippet?.publishedAt as string | undefined;
                  if (
                    pa &&
                    (!mostRecentPublishedAt || pa > mostRecentPublishedAt)
                  ) {
                    mostRecentPublishedAt = pa;
                  }
                  return vid;
                })
                .filter(Boolean) as string[];

              collectedVideoIds.push(...vids);
              pageToken = res?.nextPageToken;

              if (
                maxVideosPerChannel &&
                collectedVideoIds.length >= maxVideosPerChannel
              ) {
                collectedVideoIds = collectedVideoIds.slice(
                  0,
                  maxVideosPerChannel,
                );
                pageToken = undefined;
              }
            } while (pageToken);

            const chunkSize = 50;
            const chunkTasks: Promise<void>[] = [];
            for (let i = 0; i < collectedVideoIds.length; i += chunkSize) {
              const chunk = collectedVideoIds.slice(i, i + chunkSize);
              chunkTasks.push(
                chunkLimit(() =>
                  this.processVideoIds(
                    acc,
                    subscribers,
                    channelTitle,
                    cid,
                    chunk,
                  ),
                ),
              );
            }
            await Promise.allSettled(chunkTasks);

            const markers: Partial<Channel> = {
              lastIngestAt: new Date().toISOString(),
            };
            if (mostRecentPublishedAt)
              markers.lastVideoPublishedAt = mostRecentPublishedAt;

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

    // Write exports
    const jsonlPath = path.join(this.metaDir(), 'records.jsonl');
    const csvPath = path.join(this.metaDir(), 'records.csv');
    writeJsonl(jsonlPath, acc.jsonlRecords);
    writeCsv(csvPath, csvHeaders, acc.csvRows);

    const took = Math.round((Date.now() - start) / 1000);
    const summary: IngestSummary = {
      channelsProcessed,
      videosSeen: acc.videosSeen.value,
      imagesSaved: acc.imagesSaved.value,
      rowsUpserted: acc.rowsUpserted.value,
      tookSec: took,
      jsonlPath,
      csvPath,
      imageDir: this.imageDir(),
    };
    this.logger.log(
      `Channel-ingest summary: ${JSON.stringify(summary, null, 2)}`,
    );
    return summary;
  }
}
