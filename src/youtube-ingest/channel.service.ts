import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from './channel.entity';
import { YoutubeClient } from './youtube.client';

export type DiscoverSummary = {
  handlesProcessed: number;
  resolved: number;
  notFound: string[];
  upserts: number;
  errors: { handle: string; error: string }[];
  mappings: { handle: string; channelId: string }[];
};

export type ListForIngestOptions = {
  limit?: number;
  statuses?: Array<'idle' | 'queued' | 'running' | 'done' | 'error'>;
  channelIds?: string[]; // optional explicit set
};

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    @InjectRepository(Channel) private readonly repo: Repository<Channel>,
    private readonly yt: YoutubeClient,
  ) {}

  /** Normalize to '@handle' */
  private normHandle(h: string) {
    const s = h.trim();
    if (!s) return s;
    return s.startsWith('@') ? s : `@${s}`;
  }

  /** Upsert a Channel row from a YouTube API channel payload */
  private async upsertFromApi(item: any, handle?: string): Promise<Channel> {
    const id: string = item?.id;
    const sn = item?.snippet ?? {};
    const st = item?.statistics ?? {};
    const cd = item?.contentDetails ?? {};
    const uploads = cd?.relatedPlaylists?.uploads ?? null;

    const entity: Partial<Channel> = {
      id,
      handle: handle ?? null,
      username: null,
      title: sn?.title ?? '',
      subscribers: Number(st?.subscriberCount ?? 0),
      viewsCount: st?.viewCount != null ? Number(st.viewCount) : null,
      videosCount: st?.videoCount != null ? Number(st.videoCount) : null,
      uploadsPlaylistId: uploads,
      country: sn?.country ?? null,
      topicCategories_json: (sn?.topicDetails?.topicCategories
        ? JSON.stringify(sn.topicDetails.topicCategories)
        : null) as any, // topicDetails may not exist depending on parts
      etag: item?.etag ?? null,
      // do not touch lastIngestAt / lastVideoPublishedAt here
      // scrapeStatus left as-is or defaults when first insert
    };

    // upsert by primary key (id)
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(Channel)
      .values(entity)
      .orUpdate(
        [
          'handle',
          'title',
          'subscribers',
          'viewsCount',
          'videosCount',
          'uploadsPlaylistId',
          'country',
          'topicCategories_json',
          'etag',
        ],
        ['id'],
      )
      .execute();

    return this.repo.findOneByOrFail({ id });
  }

  /** Flow A: discovery from handles (no videos touched) */
  async discoverFromHandles(handles: string[]): Promise<DiscoverSummary> {
    const input = Array.from(
      new Set(handles.map((h) => this.normHandle(h)).filter(Boolean)),
    );

    const notFound: string[] = [];
    const errors: { handle: string; error: string }[] = [];
    const mappings: { handle: string; channelId: string }[] = [];
    let upserts = 0;

    for (const h of input) {
      try {
        const item = await this.yt.getChannelByHandle(h);
        if (!item?.id) {
          notFound.push(h);
          continue;
        }
        await this.upsertFromApi(item, h);
        mappings.push({ handle: h, channelId: item.id });
        upserts++;
      } catch (e: any) {
        errors.push({ handle: h, error: String(e?.message ?? e) });
        this.logger.warn(`discover failed for ${h}: ${String(e)}`);
      }
    }

    return {
      handlesProcessed: input.length,
      resolved: mappings.length,
      notFound,
      upserts,
      errors,
      mappings,
    };
  }

  /** Select channels to ingest; no retry policy — statuses filter is explicit */
  async listForIngest(opts: ListForIngestOptions = {}): Promise<Channel[]> {
    const { limit, statuses, channelIds } = opts;

    const qb = this.repo
      .createQueryBuilder('c')
      .orderBy('c.lastIngestAt', 'ASC', 'NULLS FIRST')
      .addOrderBy('c.id', 'ASC');

    if (statuses?.length) {
      qb.andWhere('c.scrapeStatus IN (:...statuses)', { statuses });
    }
    if (channelIds?.length) {
      qb.andWhere('c.id IN (:...ids)', { ids: channelIds });
    }
    if (limit && limit > 0) {
      qb.take(limit);
    }
    return qb.getMany();
  }

  async markStatus(
    id: string,
    status: Channel['scrapeStatus'],
    error?: string | null,
  ) {
    await this.repo.update(
      { id },
      { scrapeStatus: status, scrapeError: error ?? null },
    );
  }

  async updateMarkers(
    id: string,
    markers: Partial<Pick<Channel, 'lastIngestAt' | 'lastVideoPublishedAt'>>,
  ) {
    await this.repo.update({ id }, markers);
  }
}
