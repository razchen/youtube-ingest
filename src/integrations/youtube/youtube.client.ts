import {
  ListUploadsSinceResult,
  YoutubeApiResponse,
  YoutubeChannel,
  YoutubePlaylistItem,
  YoutubeSearchItem,
  YoutubeVideo,
} from '@/types/youtube';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

function toRfc3339DateTime(s?: string): string | undefined {
  if (!s) return undefined;
  // If it's already a full RFC-3339, keep it
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return s;
  // Accept plain YYYY-MM-DD and upgrade to start-of-day Zulu
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  return s; // last resort; you could also throw
}

async function withBackoff<T>(fn: () => Promise<T>, maxRetries = 5) {
  let attempt = 0;
  let delay = 500;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status: number | undefined = axiosErr.response?.status;

      if ((status === 403 || status === 429) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

@Injectable()
export class YoutubeClient {
  private http: AxiosInstance;
  private key: string;
  private logger = new Logger(YoutubeClient.name);

  constructor(cfg: ConfigService) {
    this.key = cfg.get<string>('YOUTUBE_API_KEY', '');
    this.http = axios.create({
      baseURL: 'https://www.googleapis.com/youtube/v3',
      timeout: 20_000,
    });
  }

  private get<T>(
    url: string,
    params: Record<string, any>,
  ): Promise<AxiosResponse<T>> {
    return withBackoff(() =>
      this.http.get<T>(url, { params: { key: this.key, ...params } }),
    );
  }

  async getChannelByHandle(handle: string) {
    const h = handle.startsWith('@') ? handle : `@${handle}`;
    const res = await this.get<YoutubeApiResponse<YoutubeChannel>>(
      '/channels',
      {
        part: 'id,snippet,statistics,contentDetails',
        forHandle: h,
        maxResults: 1,
      },
    );
    return res.data?.items?.[0] ?? null;
  }

  async getChannel(
    channelId: string,
  ): Promise<YoutubeApiResponse<YoutubeChannel>> {
    const res = await this.get<YoutubeApiResponse<YoutubeChannel>>(
      '/channels',
      {
        part: 'snippet,statistics,contentDetails',
        id: channelId,
        maxResults: 1,
      },
    );
    return res.data;
  }

  async searchChannelUploads(
    channelId: string,
    publishedAfter?: string,
    pageToken?: string,
  ): Promise<YoutubeApiResponse<YoutubeSearchItem>> {
    const params: Record<string, any> = {
      part: 'snippet',
      channelId,
      type: 'video',
      order: 'date',
      maxResults: 50,
    };
    const pa = toRfc3339DateTime(publishedAfter);
    if (pa) params.publishedAfter = pa;
    if (pageToken) params.pageToken = pageToken;

    const res = await this.get<YoutubeApiResponse<YoutubeSearchItem>>(
      '/search',
      params,
    );
    return res.data;
  }

  async listUploadsSince(
    uploadsPlaylistId: string,
    opts: { publishedAfterIso: string; maxVideos?: number },
  ): Promise<ListUploadsSinceResult> {
    let pageToken: string | undefined;
    const out: string[] = [];
    let mostRecent: string | null = null;
    let pagesFetched = 0;

    do {
      const page = await this.playlistItems(uploadsPlaylistId, pageToken);
      pagesFetched++;

      const items = page?.items ?? [];
      if (items.length === 0) break;

      for (const it of items) {
        const vid = it?.contentDetails?.videoId;
        const vpa = it?.contentDetails?.videoPublishedAt;
        if (vpa && (!mostRecent || vpa > mostRecent)) mostRecent = vpa;
        if (vid && vpa && vpa >= opts.publishedAfterIso) out.push(vid);
      }

      const lastVpa = items[items.length - 1]?.contentDetails?.videoPublishedAt;
      const hitCutoff = !!lastVpa && lastVpa < opts.publishedAfterIso;
      const reachedCap = !!opts.maxVideos && out.length >= opts.maxVideos;

      if (reachedCap) out.length = opts.maxVideos!;
      pageToken = !hitCutoff && !reachedCap ? page?.nextPageToken : undefined;
    } while (pageToken);

    return { videoIds: out, mostRecentPublishedAt: mostRecent, pagesFetched };
  }

  async playlistItems(
    playlistId: string,
    pageToken?: string,
  ): Promise<YoutubeApiResponse<YoutubePlaylistItem>> {
    const res = await this.get<YoutubeApiResponse<YoutubePlaylistItem>>(
      '/playlistItems',
      {
        part: 'contentDetails', // <-- drop snippet to save bandwidth
        playlistId,
        maxResults: 50,
        pageToken,
      },
    );
    return res.data;
  }

  async getVideos(videoIds: string[]): Promise<YoutubeVideo[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < videoIds.length; i += 50)
      chunks.push(videoIds.slice(i, i + 50));

    const results: YoutubeVideo[] = [];
    for (const chunk of chunks) {
      const res = await this.get<YoutubeApiResponse<YoutubeVideo>>('/videos', {
        part: 'snippet,statistics,contentDetails,status',
        id: chunk.join(','),
        maxResults: 50,
      });

      // console.log(JSON.stringify(res.data?.items));
      results.push(...(res.data?.items ?? []));
    }
    return results;
  }

  async searchByQuery(
    query: string,
    publishedAfter?: string,
    pageToken?: string,
  ): Promise<YoutubeApiResponse<YoutubeSearchItem>> {
    const pa = toRfc3339DateTime(publishedAfter);
    const res = await this.get<YoutubeApiResponse<YoutubeSearchItem>>(
      '/search',
      {
        q: query,
        part: 'snippet',
        type: 'video',
        order: 'date',
        publishedAfter: pa,
        maxResults: 50,
        pageToken,
      },
    );
    return res.data;
  }

  async isShortByRedirect(
    videoId: string,
  ): Promise<'short' | 'not-short' | 'unknown'> {
    try {
      const res = await axios.head(
        `https://www.youtube.com/shorts/${videoId}`,
        {
          maxRedirects: 0,
          timeout: 5000,
          // don’t follow redirects; treat 2xx/3xx as “ok”
          validateStatus: (s) => (s >= 200 && s < 400) || s === 429,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        },
      );
      if (res.status === 200) return 'short';
      if (res.status === 302 || res.status === 303) return 'not-short';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async probeThumb(url: string): Promise<boolean> {
    try {
      const res = await axios.head(url, {
        maxRedirects: 0,
        timeout: 5000,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** Prefer true maxres, then sd, then API-provided */
  async resolveBestThumbUrl(
    vid: string,
    apiThumbs: any,
  ): Promise<string | null> {
    const first = [
      apiThumbs?.maxres?.url,
      apiThumbs?.standard?.url,
      apiThumbs?.high?.url,
    ].filter(Boolean);
    for (const u of first) if (await this.probeThumb(u)) return u;

    const fallbacks = [
      `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${vid}/sddefault.jpg`,
      apiThumbs?.medium?.url,
    ].filter(Boolean) as string[];

    const race = (u: string) =>
      this.probeThumb(u).then((ok) => (ok ? u : Promise.reject(u)));

    try {
      return await Promise.any(fallbacks.map(race));
    } catch {
      return null;
    }
  }
}
