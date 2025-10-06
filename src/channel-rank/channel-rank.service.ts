// src/channel-rank/channel-rank.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Channel } from '@/channel/channel.entity';
import { Video } from '@/video/video.entity';

type OrderBy = 'subscribers_desc' | 'recent_activity' | 'none';

type CandidateItem = {
  thumbnailId: string; // we’ll use videoId for this to keep shape stable
  videoId: string;
  title: string;
  imageUrl: string;
  width: number;
  height: number;
  engagement: number | null;
};

type ChannelWithCandidates = {
  channelId: string;
  channelTitle: string;
  subscribers: number;
  items: CandidateItem[];
};

@Injectable()
export class ChannelRankService {
  constructor(
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
  ) {}

  /**
   * Fetch a batch of unranked channels (rank_score IS NULL) and attach their best 9
   * videos using Video.thumb_high_* for the preview.
   */
  async getNextUnrankedBatch(opts: {
    offset?: number;
    limit?: number;
    order?: OrderBy;
  }) {
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 30), 100);
    const order: OrderBy = opts.order ?? 'subscribers_desc';

    // 1) Pull channels (unranked)
    const qb = this.channelRepo
      .createQueryBuilder('c')
      .where('c.rank_score IS NULL')
      .andWhere('c.scrapeStatus = :scrapeStatus', { scrapeStatus: 'done' });

    if (order === 'subscribers_desc') {
      // NULLS LAST emulation for MySQL
      qb.orderBy('c.subscribers IS NULL', 'ASC') // nulls last
        .addOrderBy('c.subscribers', 'DESC');
    } else if (order === 'recent_activity') {
      qb.orderBy('c.lastVideoPublishedAt IS NULL', 'ASC') // nulls last
        .addOrderBy('c.lastVideoPublishedAt', 'DESC');
    } else {
      // no ordering
      qb.orderBy('c.id', 'ASC'); // deterministic fallback
    }

    // Use skip/take for MySQL-friendly pagination
    qb.skip(offset).take(limit);

    const channels = await qb.getMany();
    if (!channels.length) {
      return { items: [] as ChannelWithCandidates[], offset, limit, order };
    }

    const channelIds = channels.map((c) => c.id);

    // 2) Pull videos for those channels (exclude shorts). Select only what we need.
    const videos = await this.videoRepo.find({
      where: { channelId: In(channelIds) },
      select: [
        'title',
        'videoId',
        'channelId',
        'engagement',
        'has_720p_plus',
        'is_short',
        'thumb_high_url',
        'thumb_high_w',
        'thumb_high_h',
      ],
    });

    // 3) Group per channel & pre-sort (prefer 720p+, then engagement desc, nulls last)
    const vidsByChannel = new Map<string, typeof videos>();
    for (const v of videos) {
      if (v.is_short === 1) continue; // exclude Shorts
      const arr = vidsByChannel.get(v.channelId) ?? [];
      arr.push(v);
      vidsByChannel.set(v.channelId, arr);
    }

    for (const [cid, arr] of vidsByChannel) {
      arr.sort((a, b) => {
        const a720 = a.has_720p_plus ? 1 : 0;
        const b720 = b.has_720p_plus ? 1 : 0;
        if (b720 !== a720) return b720 - a720;
        const ae = a.engagement ?? -Infinity;
        const be = b.engagement ?? -Infinity;
        return be - ae;
      });
      // keep a cushion if you ever change selection; not required anymore since we use top 9 directly
      vidsByChannel.set(cid, arr);
    }

    // 4) Build response: use Video.thumb_high_* directly (skip videos without URL)
    const items: ChannelWithCandidates[] = channels.map((c) => {
      const group = vidsByChannel.get(c.id) ?? [];
      const picked: CandidateItem[] = [];

      for (const v of group) {
        if (!v.thumb_high_url) continue; // need an actual image URL
        picked.push({
          thumbnailId: v.videoId, // no separate thumbnail entity -> reuse videoId
          title: v.title,
          videoId: v.videoId,
          imageUrl: v.thumb_high_url,
          width: v.thumb_high_w ?? 0,
          height: v.thumb_high_h ?? 0,
          engagement: v.engagement ?? null,
        });
        if (picked.length >= 9) break;
      }

      return {
        channelId: c.id,
        channelTitle: c.title,
        subscribers: Number(c.subscribers || 0),
        items: picked,
      };
    });

    return { items, offset, limit, order };
  }

  /**
   * Set a single channel rank (0..5)
   */
  async setRankScore(channelId: string, score: number) {
    const ch = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!ch) throw new NotFoundException('Channel not found');
    ch.rank_score = score;
    await this.channelRepo.save(ch);
    return { channelId: ch.id, score: ch.rank_score };
  }
}
