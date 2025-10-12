import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Thumbnail } from './thumbnail.entity';
import { Video } from '../video/video.entity';
import { PaginationResponse } from '@/types/pagination';

export type CaptionJob = {
  videoId: string;
  caption: string;
  thumbnail_src: string;
};

export type CaptionAnalysis = {
  category: string; // e.g. "challenge_stunt"
  confidence: number;
  reason?: string;
  topk?: Array<{ category: string; score: number }>;
  topics?: string[]; // e.g. ["prison life"]
  style_tags?: string[]; // e.g. ["bloody", "tattooed", "orange uniform"]
  is_human_face?: boolean;
  is_text_heavy?: boolean;
  video_id?: string; // optional; we use videoId param instead
  evidence?: Record<string, any>;
};

@Injectable()
export class ThumbnailService {
  constructor(
    @InjectRepository(Thumbnail)
    private readonly thumbnailRepo: Repository<Thumbnail>,
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
  ) {}

  /**
   * Return the next uncaptioned thumbnail.
   * Minimal heuristic: prefer higher engagement, then newer publish date.
   * No locking/claiming since you said you don't need it.
   */
  async getNextUncaptioned(): Promise<Partial<Thumbnail>[] | null> {
    const next = await this.thumbnailRepo.find({
      select: {
        videoId: true,
        caption: true,
        thumbnail_s3_url: true,
      },
      where: { caption: IsNull() },
      order: { engagementScore: 'DESC', publishedAt: 'DESC' },
      take: 10,
    });

    return next.length ? next : null;
  }

  // POST /v1/thumbnails/caption/result
  async saveCaptionAnalysis(a: CaptionAnalysis) {
    const videoId = a.video_id;
    console.log('videoId', videoId);
    if (!videoId) {
      console.log('no videoId');
      throw new NotFoundException('Thumbnail not found');
    }
    const row = await this.thumbnailRepo.findOne({ where: { videoId } });
    if (!row) {
      console.log('no row');
      throw new NotFoundException('Thumbnail not found');
    }

    // ---- style bucket ----
    const styleBucket = a.category;

    // ---- composition tags from faces_json + analysis flags ----
    const compTags = this.deriveCompositionTags(row, a);

    // ---- build final caption tags ----
    const base = [...(a.style_tags ?? []), ...(a.topics ?? []), ...compTags];

    const caption = this.toCaption(base);

    row.caption = caption;
    row.styleBucket = styleBucket;
    row.captionedAt = new Date();
    row.caption_meta_json = JSON.stringify(a);

    await this.thumbnailRepo.save(row);
    return { ok: true, styleBucket, caption };
  }

  private deriveCompositionTags(row: Thumbnail, a: CaptionAnalysis): string[] {
    const tags = new Set<string>();

    // Faces: prefer DB faces_json for count/area
    // Expected shape:
    // row.faces_json = '{"count":1,"largest":{"areaPct":0.0732}, ... }'
    try {
      if (row.faces_json) {
        const faces = JSON.parse(row.faces_json as unknown as string);
        const count = faces?.count ?? 0;
        const areaPct = faces?.largest?.areaPct ?? 0;

        if (count === 0) tags.add('no_face');
        if (count === 1) tags.add('single_face');
        if (count >= 2) tags.add('multi_face');
        if (areaPct >= 0.1)
          tags.add('big_face'); // close-up emphasis
        else if (areaPct >= 0.05) tags.add('big_face'); // still sizeable
      } else if (a.is_human_face === false) {
        tags.add('no_face');
      }
    } catch {
      /* ignore parse errors */
    }

    // Text density
    if (a.is_text_heavy === true) tags.add('text_heavy');
    if (a.is_text_heavy === false) tags.add('low_text');

    return Array.from(tags);
  }

  private toCaption(list: string[]): string {
    const cleaned = list
      .map((s) => (s ?? '').toString().trim().toLowerCase())
      .filter(Boolean);
    // de-dupe while preserving order
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of cleaned) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    return deduped.join(', ');
  }

  async findAll(
    page: number,
    limit: number,
  ): Promise<PaginationResponse<Thumbnail>> {
    const skip = page && page > 0 ? (page - 1) * limit : 0;
    const items = await this.thumbnailRepo
      .createQueryBuilder('thumbnail')
      .select([
        'thumbnail.videoId',
        'thumbnail.styleBucket',
        'thumbnail.title',
        'thumbnail.caption',
        'thumbnail.thumbnail_s3_url',
      ])
      .skip(skip)
      .take(limit)
      .getMany();

    const total = await this.thumbnailRepo.count();
    return { items, page, total, limit };
  }
}
