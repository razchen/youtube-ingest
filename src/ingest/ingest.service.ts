import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Thumbnail } from '../thumbnail/thumbnail.entity';
import { ensureDir, downloadToFile, imageMeta } from '../common/fs.util';
import { sha256Buffer, pHash, assignSplit } from '../common/hash.util';
import { ocrBasic } from '../common/ocr.util';
import { analyzeImage } from '../common/vision.util';
import { refineVision } from '../common/vision-post.util';

import * as path from 'path';
import * as fs from 'fs';
import pLimit from 'p-limit';
import { YoutubeClient } from '../integrations/youtube/youtube.client';
import { IngestAccumulators, IngestSummary } from '@/types/ingest';
import { Video } from '../video/video.entity';
import { YoutubeVideo } from '@/types/youtube';

type YoutubeSnippet = NonNullable<YoutubeVideo['snippet']>;

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private readonly dataDir: string;

  constructor(
    private readonly cfg: ConfigService,
    private readonly yt: YoutubeClient,
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
    @InjectRepository(Thumbnail)
    private readonly thumbnailRepo: Repository<Thumbnail>,
  ) {
    this.dataDir = this.cfg.get('DATA_DIR', './data');
    ensureDir(this.imageDir());
    ensureDir(this.metaDir());
  }

  private safeParseJson<T>(s: string | null | undefined): T | null {
    if (!s) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }

  private imageDir() {
    return path.resolve(this.dataDir, 'images');
  }
  private metaDir() {
    return path.resolve(this.dataDir, 'meta');
  }
  /** Returns one page of eligible video *pointers* (lightweight). */
  private async selectEligiblePage(opts: {
    sinceDays: number;
    pageSize: number; // e.g., 1000
    cursorPublishedAt?: Date; // keyset cursor
    cursorVideoId?: string; // tiebreaker
  }) {
    const { sinceDays, pageSize, cursorPublishedAt, cursorVideoId } = opts;

    let qb = this.videoRepo
      .createQueryBuilder('v')
      .leftJoin(Thumbnail, 't', 't.videoId = v.videoId')
      .where('v.is_short = 0')
      .andWhere('v.has_720p_plus = 1')
      .andWhere('t.videoId IS NULL')
      .andWhere('v.publishedAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :d DAY)', {
        d: sinceDays,
      })
      .andWhere('v.engagement > 0.7')
      // stable keyset order: oldest first to avoid rework if interrupted
      .orderBy('v.publishedAt', 'ASC')
      .addOrderBy('v.videoId', 'ASC');

    if (cursorPublishedAt) {
      qb = qb.andWhere(
        '(v.publishedAt > :cp) OR (v.publishedAt = :cp AND v.videoId > :cv)',
        { cp: cursorPublishedAt, cv: cursorVideoId ?? '' },
      );
    }

    return qb
      .select([
        'v.videoId AS videoId',
        'v.channelId AS channelId',
        'v.publishedAt AS publishedAt',
      ])
      .take(pageSize)
      .getRawMany<{ videoId: string; channelId: string; publishedAt: Date }>();
  }

  /** Enrich a single Video row (moved from your loop body). */
  private async enrichOne(row: Video, acc: IngestAccumulators) {
    // resolve thumbnail src from cached snippet, fallback to probe
    const snippet = this.safeParseJson<YoutubeSnippet>(row.api_snippet_json);

    const title = row.title ?? snippet?.title ?? '';
    const apiThumbs = snippet?.thumbnails ?? {};
    const src =
      apiThumbs?.maxres?.url ??
      apiThumbs?.standard?.url ??
      apiThumbs?.high?.url ??
      (await this.yt.resolveBestThumbUrl(row.videoId, apiThumbs));
    if (!src) {
      this.logger.warn(`No thumbnail for ${row.videoId}, skipping.`);
      return;
    }

    const savePath = path.join(
      this.imageDir(),
      `${row.channelId}_${row.videoId}.jpg`,
    );
    try {
      // avoid sync fs calls
      await fs.promises.access(savePath).catch(async () => {
        await downloadToFile(src, savePath);
        acc.imagesSaved.value++;
      });
    } catch (e) {
      this.logger.warn(`Download failed ${src} -> ${savePath}: ${String(e)}`);
      return;
    }

    // hashes
    const buf = await fs.promises.readFile(savePath);
    const sha = sha256Buffer(buf);
    const ph = await pHash(savePath);

    // dimensions (prefer cached, fallback to probe)
    let nativeW = row.thumb_max_w ?? row.thumb_high_w ?? null;
    let nativeH = row.thumb_max_h ?? row.thumb_high_h ?? null;
    if (nativeW == null || nativeH == null) {
      const meta = await imageMeta(savePath);
      nativeW = meta.width ?? nativeW ?? null;
      nativeH = meta.height ?? nativeH ?? null;
    }

    // OCR + vision
    const ocr = await ocrBasic(savePath);
    const visionRaw = await analyzeImage(savePath, {
      title,
      ocrText: (ocr as any)?.rawText ?? '',
    });
    const refined = refineVision(visionRaw, {
      title,
      ocrText: (ocr as any)?.rawText ?? '',
    });

    const tRow: Partial<Thumbnail> = {
      videoId: row.videoId,
      channelId: row.channelId,
      title: row.title,
      publishedAt: row.publishedAt.toISOString(),
      views: row.viewCount ?? 0,
      likes: row.likeCount ?? null,

      thumbnail_savedPath: savePath,
      thumbnail_src: src,
      thumbnail_nativeW: nativeW,
      thumbnail_nativeH: nativeH,

      ocr_charCount: (ocr as any)?.charCount ?? null,
      ocr_areaPct: (ocr as any)?.areaPct ?? null,

      engagementScore: row.engagement ?? null,
      hash_pHash: ph,
      hash_sha256: sha,

      split: assignSplit(row.channelId),
      fetchedAt: new Date().toISOString(),

      categoryId: row.categoryId ?? null,
      durationSec: row.durationSec ?? null,
      madeForKids: row.madeForKids ?? null,

      faces_json: refined.faces_json,
      objects_json: refined.objects_json,
      palette_json: refined.palette_json,
      contrast: refined.contrast ?? null,
      entropy: null,
      saliency_json: null,
      flags_json: null,
      etag: row.etag ?? null,
      notes: null,
    };

    await this.thumbnailRepo.upsert(tRow, ['videoId']);
    acc.rowsUpserted.value++;
  }

  /** Super simple: page → fetch full rows → enrich (limited concurrency) → next page. */
  async runEnrichEligible(input?: {
    sinceDays?: number;
    pageSize?: number; // default 1000
    concurrency?: number; // default 3 (heavy)
  }): Promise<IngestSummary> {
    const sinceDays = input?.sinceDays ?? 365;
    const pageSize = input?.pageSize ?? 1000;
    const concurrency = input?.concurrency ?? 3;

    const acc: IngestAccumulators = {
      videosSeen: { value: 0 },
      imagesSaved: { value: 0 },
      rowsUpserted: { value: 0 },
    };

    const per = pLimit(concurrency);
    let cursorPublishedAt: Date | undefined;
    let cursorVideoId: string | undefined;

    const started = Date.now();

    while (true) {
      const page = await this.selectEligiblePage({
        sinceDays,
        pageSize,
        cursorPublishedAt,
        cursorVideoId,
      });
      if (!page.length) break;

      acc.videosSeen.value += page.length;

      // fetch full Video rows for the page in one query
      const ids = page.map((r) => r.videoId);
      const videos = await this.videoRepo.find({ where: { videoId: In(ids) } });
      const byId = new Map(videos.map((v) => [v.videoId, v]));

      // enrich with limited concurrency
      await Promise.allSettled(
        page.map((r) => {
          const row = byId.get(r.videoId);
          return row ? per(() => this.enrichOne(row, acc)) : Promise.resolve();
        }),
      );

      // advance cursor to *after* the last processed row
      const last = page[page.length - 1];
      cursorPublishedAt = last.publishedAt;
      cursorVideoId = last.videoId;
    }

    const tookSec = Math.round((Date.now() - started) / 1000);
    return {
      channelsProcessed: 0,
      videosSeen: acc.videosSeen.value,
      imagesSaved: acc.imagesSaved.value,
      rowsUpserted: acc.rowsUpserted.value,
      tookSec,
      imageDir: this.imageDir(),
    };
  }
}
