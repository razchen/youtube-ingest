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
import {
  computeEntropyBits,
  computeLumaAndSat,
  computeSaliencyFeatures,
} from '@/common/image-metrics.util';
import { categorizeThumbnail } from '@/common/categorize.util';
import { S3Service } from '@/infra/s3/s3.service';

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
    private readonly s3: S3Service,
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
      .andWhere('v.channelId = :channelId', {
        channelId: 'UCX6OQ3DkcsbYNE6H8uQQuVA',
      })
      // stable keyset order: oldest first to avoid rework if interrupted
      .orderBy('v.publishedAt', 'ASC')
      .addOrderBy('v.videoId', 'ASC');
    if (cursorPublishedAt) {
      qb = qb.andWhere(
        '(v.publishedAt > :cp) OR (v.publishedAt = :cp AND v.videoId > :cv)',
        { cp: cursorPublishedAt, cv: cursorVideoId ?? '' },
      );
    }

    qb.select([
      'v.videoId AS videoId',
      'v.channelId AS channelId',
      'v.publishedAt AS publishedAt',
    ]).limit(pageSize);

    this.logger.log('Query: ', qb.getQuery());

    const page = await qb.getRawMany<{
      videoId: string;
      channelId: string;
      publishedAt: Date;
    }>();

    this.logger.log('Found videos: ', page.length);

    return page;
  }

  /** Enrich a single Video row (moved from your loop body). */
  private async enrichOne(row: Video, acc: IngestAccumulators) {
    // resolve thumbnail src from cached snippet, fallback to probe
    const snippet = this.safeParseJson<YoutubeSnippet>(row.api_snippet_json);

    const title = row.title ?? snippet?.title ?? '';
    this.logger.log(title);
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
    let refined: any;
    let visionRaw: any;
    let ocr: any;
    this.logger.log('starting OCR');
    try {
      ocr = await ocrBasic(savePath);
      visionRaw = await analyzeImage(savePath, {
        title,
        ocrText: (ocr as any)?.rawText ?? '',
      });
      this.logger.log('finished OCR');
    } catch (e) {
      this.logger.warn(`OCR failed for ${row.videoId}: ${String(e)}`);
      return;
    }

    try {
      refined = refineVision(visionRaw, {
        title,
        ocrText: (ocr as any)?.rawText ?? '',
      });
    } catch (e) {
      this.logger.warn(`Refine failed for ${row.videoId}: ${String(e)}`);
      return;
    }

    let entropyBits: number | null = null;
    let saliency: {
      centerDist: number;
      areaRatio: number;
      blobCount: number;
    } | null = null;

    try {
      // Run in parallel
      [entropyBits, saliency] = await Promise.all([
        computeEntropyBits(savePath),
        computeSaliencyFeatures(savePath, {
          width: 256,
          percentile: 0.85,
          stride: 2,
        }),
      ]);
    } catch (e) {
      this.logger.warn(
        `entropy/saliency failed for ${row.videoId}: ${String(e)}`,
      );
    }

    const { meanLuma, meanSat } = await computeLumaAndSat(savePath);

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
      entropy: entropyBits ?? null,
      saliency_json: saliency ? JSON.stringify(saliency) : null,
      meanLuma,
      meanSat,
      flags_json: null,
      etag: row.etag ?? null,
      notes: null,
    };

    await this.thumbnailRepo.upsert(tRow, ['videoId']);
    acc.rowsUpserted.value++;

    /** Upload the original image to S3 *after* we’ve finished all CPU work. */
    try {
      const key = `thumbnails/${row.channelId}/${row.videoId}.jpg`;
      const { url } = await this.s3.uploadFile(savePath, key, 'image/jpeg');

      await this.thumbnailRepo.update(
        { videoId: row.videoId },
        { thumbnail_s3_url: url },
      );

      // Remove the local file now that we’re done with it.
      await fs.promises.unlink(savePath).catch(() => {});
      this.logger.log(`Uploaded to S3 and deleted local file: ${url}`);
    } catch (e) {
      // Keep going—if upload fails, we still have all other data persisted.
      this.logger.warn(`S3 upload failed for ${row.videoId}: ${String(e)}`);
    }
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
      break;
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

  async categorize() {
    const thumbnails = await this.thumbnailRepo.find();

    for (const t of thumbnails) {
      console.log(t.title);
      console.log(t.thumbnail_src);
      const out = categorizeThumbnail(t);

      console.log(out);
    }
  }
}
