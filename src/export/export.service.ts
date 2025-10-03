import { Injectable, Logger } from '@nestjs/common';
import { Thumbnail } from '../thumbnail/thumbnail.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ensureDir } from '@/common/fs.util';
import * as path from 'path';
import * as fs from 'fs';
import { Channel } from '@/channel/channel.entity';

type WithChannelExtras<T> = T & {
  channelTitle: string | null;
  subscribers: number | null;
};

type RawExtras = {
  channelTitle: string | null;
  subscribers: string | number | null; // MySQL can return strings for numbers
};

type FacesCSV = {
  faces_count?: number | null;
  faces_largest_areaPct?: number | null;
};

type PaletteCSV = {
  palette_top1?: string | null;
};

type ObjectsCSV = {
  tags?: string | null;
};

// Your Thumbnail likely has these as `any`; augment the local export shape:
type CSVThumbnail = WithChannelExtras<Thumbnail> & {
  faces_json?: { csv?: FacesCSV } | null;
  palette_json?: { csv?: PaletteCSV } | null;
  objects_json?: { csv?: ObjectsCSV } | null;
};

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @InjectRepository(Thumbnail)
    private readonly repo: Repository<Thumbnail>,
  ) {}

  private csvHeaders = [
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

  // map DB row -> CSV row
  private toCsvRow(t: CSVThumbnail): Array<string | number | null> {
    const faces_count = t.faces_json?.csv?.faces_count ?? null;
    const faces_largest_areaPct =
      t.faces_json?.csv?.faces_largest_areaPct ?? null;
    const contrast = t.contrast ?? null;
    const palette_top1 = t.palette_json?.csv?.palette_top1 ?? null;
    const tags = t.objects_json?.csv?.tags ?? null;

    return [
      t.videoId,
      t.channelId,
      t.channelTitle ?? null,
      t.title ?? null,
      t.publishedAt ?? null,
      t.views ?? null,
      t.likes ?? null,
      t.subscribers ?? null,
      t.thumbnail_savedPath ?? null,
      t.thumbnail_src ?? null,
      t.thumbnail_nativeW ?? null,
      t.thumbnail_nativeH ?? null,
      t.ocr_charCount ?? null,
      t.ocr_areaPct ?? null,
      t.engagementScore ?? null,
      t.hash_pHash ?? null,
      t.hash_sha256 ?? null,
      t.split ?? null,
      t.fetchedAt ?? null,
      faces_count,
      faces_largest_areaPct,
      contrast,
      palette_top1,
      tags,
    ];
  }

  // map DB row -> JSONL record (choose the fields you want)
  private toJsonlRecord(t: CSVThumbnail): Record<string, any> {
    return {
      videoId: t.videoId,
      channelId: t.channelId,
      channelTitle: t.channelTitle,
      title: t.title,
      publishedAt: t.publishedAt,
      views: t.views,
      likes: t.likes,
      subscribers: t.subscribers,
      thumbnail: {
        path: t.thumbnail_savedPath,
        src: t.thumbnail_src,
        w: t.thumbnail_nativeW,
        h: t.thumbnail_nativeH,
      },
      ocr: {
        charCount: t.ocr_charCount,
        areaPct: t.ocr_areaPct,
      },
      engagementScore: t.engagementScore,
      hashes: { pHash: t.hash_pHash, sha256: t.hash_sha256 },
      split: t.split,
      fetchedAt: t.fetchedAt,
      faces_json: t.faces_json,
      objects_json: t.objects_json,
      palette_json: t.palette_json,
      contrast: t.contrast,
      entropy: t.entropy,
      saliency_json: t.saliency_json,
      flags_json: t.flags_json,
      etag: t.etag,
      notes: t.notes,
      categoryId: t.categoryId,
      durationSec: t.durationSec,
      madeForKids: t.madeForKids,
      tags_json: t.tags_json,
    };
  }

  /**
   * Export thumbnails from DB (optionally filtered) into CSV + JSONL files.
   * Reads in batches to keep memory bounded.
   */
  async exportThumbnailsFromDb(options?: {
    outCsvPath: string;
    outJsonlPath: string;
    batchSize?: number; // default 2000
    channelIds?: string[]; // optional filter
    publishedAfter?: string; // optional ISO filter
  }): Promise<{ csvPath: string; jsonlPath: string; rows: number }> {
    const outCsvPath = options?.outCsvPath;
    const outJsonlPath = options?.outJsonlPath;
    const batchSize = options?.batchSize ?? 2000;

    if (!outCsvPath || !outJsonlPath) {
      throw new Error('outCsvPath and outJsonlPath are required');
    }

    // ensure dir
    ensureDir(path.dirname(outCsvPath));
    ensureDir(path.dirname(outJsonlPath));

    // clear files
    if (fs.existsSync(outCsvPath)) fs.unlinkSync(outCsvPath);
    if (fs.existsSync(outJsonlPath)) fs.unlinkSync(outJsonlPath);

    // write CSV header
    // If writeCsv only writes full arrays, we can write header manually:
    fs.appendFileSync(outCsvPath, this.csvHeaders.join(',') + '\n');

    let total = 0;
    let lastId: string | null = null;

    for (;;) {
      // Build a paged query with a stable sort (by videoId)
      const qb = this.repo
        .createQueryBuilder('t')
        .leftJoin(Channel, 'c', 'c.id = t.channelId')
        .select('t') // get the full Thumbnail entity typed
        .addSelect('c.title', 'channelTitle')
        .addSelect('c.subscribers', 'subscribers')
        .orderBy('t.videoId', 'ASC')
        .take(batchSize);

      if (lastId) qb.where('t.videoId > :lastId', { lastId });
      if (options?.channelIds?.length)
        qb.andWhere('t.channelId IN (:...cids)', { cids: options.channelIds });
      if (options?.publishedAfter)
        qb.andWhere('t.publishedAt >= :pa', { pa: options.publishedAfter });

      const { raw, entities } = await qb.getRawAndEntities();
      if (!entities.length) break;

      const extras = raw as RawExtras[]; // single, centralized assertion

      const rows: CSVThumbnail[] = entities.map((e, i) => ({
        ...e,
        channelTitle: extras[i].channelTitle,
        subscribers:
          extras[i].subscribers != null ? Number(extras[i].subscribers) : null,
      }));

      total += rows.length;
      lastId = entities[entities.length - 1].videoId;

      // append to CSV + JSONL
      const csvLines = rows.map((t) =>
        this.toCsvRow(t)
          .map((v) => (v == null ? '' : String(v).replace(/"/g, '""')))
          .map((v) =>
            v.includes(',') || v.includes('"') || v.includes('\n')
              ? `"${v}"`
              : v,
          )
          .join(','),
      );
      fs.appendFileSync(outCsvPath, csvLines.join('\n') + '\n');

      const jsonlLines = rows.map((t) => JSON.stringify(this.toJsonlRecord(t)));
      fs.appendFileSync(outJsonlPath, jsonlLines.join('\n') + '\n');

      total += rows.length;
      lastId = rows[rows.length - 1].videoId;
    }

    this.logger.log(
      `Exported ${total} rows -> ${outCsvPath} & ${outJsonlPath}`,
    );
    return { csvPath: outCsvPath, jsonlPath: outJsonlPath, rows: total };
  }
}
