import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Thumbnail } from './youtube-ingest.entity';
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
import * as path from 'path';
import * as fs from 'fs';
import pLimit from 'p-limit';
import { YoutubeClient } from './youtube.client';
import { IngestSummary } from '@/types/ingest';

type IngestParams = {
  channelIds?: string[];
  queries?: string[];
  publishedAfter?: string;
  maxVideosPerChannel?: number;
};

@Injectable()
export class YoutubeIngestService {
  private readonly logger = new Logger(YoutubeIngestService.name);
  private readonly dataDir: string;

  constructor(
    private readonly cfg: ConfigService,
    private readonly yt: YoutubeClient,
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

  async runIngest(params: IngestParams): Promise<IngestSummary> {
    const cfgChannels: string[] = (
      this.cfg.get<string>('INGEST_CHANNEL_IDS', '') || ''
    )
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);

    const channelIds: string[] =
      params.channelIds && params.channelIds.length > 0
        ? params.channelIds
        : cfgChannels;

    const publishedAfter: string | undefined =
      params.publishedAfter ||
      this.cfg.get<string>('INGEST_PUBLISHED_AFTER') ||
      undefined;

    const maxVideosPerChannel: number | undefined =
      params.maxVideosPerChannel ?? undefined;
    const queries: string[] | undefined = params.queries ?? undefined;

    const start = Date.now();
    let channelsProcessed = 0;
    let videosSeen = 0;
    let imagesSaved = 0;
    let rowsUpserted = 0;

    const jsonlRecords: any[] = [];
    const csvRows: any[][] = [];

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
    ];

    const throttler = pLimit(6); // lightweight concurrency limit

    // Helper to process a batch of videoIds
    const processVideoIds = async (
      subscribers: number,
      channelTitle: string,
      channelId: string,
      videoIds: string[],
    ) => {
      const videoItems = await this.yt.getVideos(videoIds);
      for (const v of videoItems) {
        videosSeen++;
        const vid = v?.id;
        if (!vid) continue;

        const snippet = v?.snippet ?? {};
        const statistics = v?.statistics ?? {};
        const contentDetails = v?.contentDetails ?? {};
        const live = v?.liveStreamingDetails ?? {};

        // choose thumbnail
        const t = snippet?.thumbnails ?? {};
        const chosen = t.maxres ?? t.high ?? t.medium ?? null;
        const src = chosen?.url;
        if (!src) {
          this.logger.warn(`No viable thumbnail for video ${vid}, skipping.`);
          continue;
        }

        const savePath = path.join(this.imageDir(), `${vid}.jpg`);
        // Dedup/skip if already exists by videoId
        if (!fs.existsSync(savePath)) {
          try {
            await downloadToFile(src, savePath);
            imagesSaved++;
          } catch (e) {
            this.logger.warn(
              `Failed to download thumbnail ${src} -> ${savePath}: ${String(e)}`,
            );
            continue;
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
        const title: string = snippet?.title ?? '';
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
          channelTitle,
          title,
          publishedAt,
          views,
          likes,
          subscribers,
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
          // future fields kept null for now:
          categoryId,
          tags_json: null,
          durationSec,
          isLive,
          madeForKids,
          faces_json: null,
          objects_json: null,
          palette_json: null,
          contrast: null,
          entropy: null,
          saliency_json: null,
          flags_json: null,
          etag: v?.etag ?? null,
          notes: null,
        };

        // Upsert
        await this.repo.upsert(row as Thumbnail, ['videoId']);
        rowsUpserted++;

        // Export buffers
        jsonlRecords.push(row);
        csvRows.push([
          row.videoId,
          row.channelId,
          row.channelTitle,
          row.title,
          row.publishedAt,
          row.views,
          row.likes,
          row.subscribers,
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
        ]);
      }
    };

    // --- Ingest by channels ---
    for (const channelId of channelIds) {
      try {
        const ch = await this.yt.getChannel(channelId);
        const item = ch?.items?.[0];
        if (!item) {
          this.logger.warn(`Channel not found: ${channelId}`);
          continue;
        }
        const subscribers = Number(item?.statistics?.subscriberCount ?? 0);
        const channelTitle = item?.snippet?.title ?? '';

        console.log('Fetching videos for', channelTitle);

        // Use search.list by channel
        let pageToken: string | undefined;
        let collectedVideoIds: string[] = [];
        do {
          const res = await this.yt.searchChannelUploads(
            channelId,
            publishedAfter,
            pageToken,
          );
          const items: any[] = res?.items ?? [];
          const vids = items.map((it: any) => it?.id?.videoId).filter(Boolean);
          collectedVideoIds.push(...vids);
          pageToken = res?.nextPageToken;
          if (
            maxVideosPerChannel &&
            collectedVideoIds.length >= maxVideosPerChannel
          )
            break;
        } while (pageToken);

        if (
          maxVideosPerChannel &&
          collectedVideoIds.length > maxVideosPerChannel
        ) {
          collectedVideoIds = collectedVideoIds.slice(0, maxVideosPerChannel);
        }

        // Process in chunks to keep request size reasonable
        const chunkSize = 50;
        for (let i = 0; i < collectedVideoIds.length; i += chunkSize) {
          const chunk = collectedVideoIds.slice(i, i + chunkSize);

          this.logger.log(`Processing chunk of ${chunk.length} videos`);
          await throttler(() =>
            processVideoIds(subscribers, channelTitle, channelId, chunk),
          );
        }

        channelsProcessed++;
      } catch (e) {
        this.logger.error(`Failed channel ${channelId}: ${String(e)}`);
      }
    }

    // --- Optional query mode ---
    if (queries?.length) {
      for (const q of queries) {
        try {
          let pageToken: string | undefined;
          let round = 0;
          do {
            const res = await this.yt.searchByQuery(
              q,
              publishedAfter,
              pageToken,
            );
            const items: any[] = res?.items ?? [];
            const byChannel: Record<string, string[]> = {};
            const channelTitles: Record<string, string> = {};
            for (const it of items) {
              const vid = it?.id?.videoId;
              const cid = it?.snippet?.channelId;
              const ct = it?.snippet?.channelTitle ?? '';
              if (vid && cid) {
                (byChannel[cid] ||= []).push(vid);
                channelTitles[cid] = ct;
              }
            }

            // Fetch subscribers per channel for engagement score
            for (const [cid, vids] of Object.entries(byChannel)) {
              try {
                const ch = await this.yt.getChannel(cid);
                const item = ch?.items?.[0];
                const subs = Number(item?.statistics?.subscriberCount ?? 0);
                const ct = channelTitles[cid] ?? item?.snippet?.title ?? '';
                // process
                const chunkSize = 50;
                for (let i = 0; i < vids.length; i += chunkSize) {
                  const chunk = vids.slice(i, i + chunkSize);
                  await throttler(() => processVideoIds(subs, ct, cid, chunk));
                }
              } catch (e) {
                this.logger.warn(
                  `Query mode channel fetch failed ${cid}: ${String(e)}`,
                );
              }
            }

            pageToken = res?.nextPageToken;
            round++;
            if (maxVideosPerChannel && round * 50 >= maxVideosPerChannel) break; // soft cap
          } while (pageToken);
        } catch (e) {
          this.logger.error(`Query "${q}" failed: ${String(e)}`);
        }
      }
    }

    // Write exports
    const jsonlPath = path.join(this.metaDir(), 'records.jsonl');
    const csvPath = path.join(this.metaDir(), 'records.csv');
    writeJsonl(jsonlPath, jsonlRecords);
    writeCsv(csvPath, csvHeaders, csvRows);

    const took = Math.round((Date.now() - start) / 1000);
    const summary = {
      channelsProcessed,
      videosSeen,
      imagesSaved,
      rowsUpserted,
      tookSec: took,
      jsonlPath,
      csvPath,
      imageDir: this.imageDir(),
    };
    this.logger.log(`Ingest summary: ${JSON.stringify(summary, null, 2)}`);
    return summary;
  }
}
