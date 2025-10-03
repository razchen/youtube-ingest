import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from './channel.entity';
import { YoutubeClient } from './youtube.client';
import { YoutubeChannel } from '@/types/youtube';
import * as path from 'path';
import { promises as fs } from 'fs';
import pLimit from 'p-limit';

type DiscoverRow = {
  handle: string;
  country?: string | null;
  categories?: string[] | undefined;
};

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
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    private readonly yt: YoutubeClient,
  ) {}

  /** Normalize to '@handle' */
  private normHandle(h: string) {
    const s = h.trim();
    if (!s) return s;
    return s.startsWith('@') ? s : `@${s}`;
  }

  /** Upsert a Channel row from a YouTube API channel payload */
  private async upsertFromApi(
    item: YoutubeChannel & {
      country?: string | null;
      categories?: string[] | undefined;
    },
    handle?: string,
    overrides?: { country?: string | null; categories?: string[] | undefined },
  ): Promise<Channel> {
    const id: string = item?.id;
    const sn = item?.snippet ?? {};
    const st = item?.statistics ?? {};
    const cd = item?.contentDetails ?? {};
    const uploads = cd?.relatedPlaylists?.uploads ?? null;

    // Prefer file-provided values over YouTube (YT often lacks these)
    const countryFromFile = overrides?.country ?? null;
    const categoriesFromFile = overrides?.categories ?? undefined;

    const entity: Partial<Channel> = {
      id,
      handle: handle ?? null,
      username: null,
      title: sn?.title ?? '',
      subscribers: Number(st?.subscriberCount ?? 0),
      viewsCount: st?.viewCount != null ? Number(st.viewCount) : null,
      videosCount: st?.videoCount != null ? Number(st.videoCount) : null,
      uploadsPlaylistId: uploads,

      // COUNTRY: prefer file; fallback to snippet.country; else null
      country: countryFromFile ?? null,

      /**
       * CATEGORIES: if provided from file, use them (canonical).
       * If you want to keep YT topicDetails as a fallback, you can do:
       *    const ytTopics = item?.topicDetails?.topicCategories ?? null;
       * but many API calls won’t include topicDetails unless requested in parts and may still be empty.
       */
      topicCategories_json: categoriesFromFile
        ? JSON.stringify(categoriesFromFile)
        : null,

      etag: item?.etag ?? null,
    };

    await this.channelRepo
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

    return this.channelRepo.findOneByOrFail({ id });
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

    const qb = this.channelRepo
      .createQueryBuilder('c')
      .orderBy('c.lastIngestAt', 'ASC')
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
    await this.channelRepo.update(
      { id },
      { scrapeStatus: status, scrapeError: error ?? null },
    );
  }

  async updateMarkers(
    id: string,
    markers: Partial<Pick<Channel, 'lastIngestAt' | 'lastVideoPublishedAt'>>,
  ) {
    await this.channelRepo.update({ id }, markers);
  }

  async discoverFromJson(filePath: string): Promise<DiscoverSummary> {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    const raw = await fs.readFile(abs, 'utf8');

    let rows: DiscoverRow[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON root must be an array');
      }
      rows = parsed.map((r) => ({
        handle: String(r.handle ?? '').trim(),
        country: (r.country ?? null) ? String(r.country).trim() : null,
        categories: Array.isArray(r.categories)
          ? r.categories.map((x) => String(x).trim()).filter(Boolean)
          : undefined,
      }));
    } catch (e: any) {
      throw new Error(`Invalid JSON at ${abs}: ${e?.message ?? e}`);
    }

    // Normalize + merge duplicates across file
    const merged = this.mergeDiscoverRows(rows);

    const notFound: string[] = [];
    const errors: { handle: string; error: string }[] = [];
    const mappings: { handle: string; channelId: string }[] = [];
    let upserts = 0;

    const limit = pLimit(8); // concurrency

    await Promise.allSettled(
      merged.map(({ handle, country, categories }) =>
        limit(async () => {
          const h = this.normHandle(handle);
          if (!h) return;

          try {
            const item = await this.yt.getChannelByHandle(h);
            if (!item?.id) {
              notFound.push(h);
              return;
            }
            await this.upsertFromApi(item, h, { country, categories });
            mappings.push({ handle: h, channelId: item.id });
            upserts++;
          } catch (e: any) {
            errors.push({ handle: h, error: String(e?.message ?? e) });
            this.logger.warn(`discoverFromJson failed for ${h}: ${String(e)}`);
          }
        }),
      ),
    );

    return {
      handlesProcessed: merged.length,
      resolved: mappings.length,
      notFound,
      upserts,
      errors,
      mappings,
    };
  }

  /**
   * Merge duplicates from the input file:
   * - Keep one entry per handle
   * - Prefer the last non-empty country (or first; choose your policy)
   * - Union/deduplicate categories
   */
  private mergeDiscoverRows(rows: DiscoverRow[]): DiscoverRow[] {
    const byHandle = new Map<
      string,
      { country: string | null; categories: Set<string> }
    >();

    for (const r of rows) {
      const h = (r.handle ?? '').trim();
      if (!h) continue;

      const prev = byHandle.get(h) ?? {
        country: null,
        categories: new Set<string>(),
      };
      const country = r.country && r.country.length ? r.country : prev.country;
      const categories = prev.categories;
      (r.categories ?? []).forEach((c) => categories.add(c));

      byHandle.set(h, { country: country ?? null, categories });
    }

    return Array.from(byHandle.entries()).map(
      ([handle, { country, categories }]) => ({
        handle,
        country,
        categories: Array.from(categories.values()).sort(),
      }),
    );
  }
}
