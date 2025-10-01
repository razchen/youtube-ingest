import {
  YoutubeApiResponse,
  YoutubeChannel,
  YoutubeSearchItem,
  YoutubeSnippet,
  YoutubeVideo,
} from '@/types/youtube';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

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
    const res = await this.get<YoutubeApiResponse<YoutubeSearchItem>>(
      '/search',
      {
        part: 'snippet',
        channelId,
        type: 'video',
        order: 'date',
        publishedAfter,
        maxResults: 50,
        pageToken,
      },
    );
    return res.data;
  }

  async playlistItems(
    playlistId: string,
    pageToken?: string,
  ): Promise<
    YoutubeApiResponse<{
      snippet: YoutubeSnippet;
      contentDetails: { videoId: string };
    }>
  > {
    const res = await this.get<
      YoutubeApiResponse<{
        snippet: YoutubeSnippet;
        contentDetails: { videoId: string };
      }>
    >('/playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: 50,
      pageToken,
    });
    return res.data;
  }

  async getVideos(videoIds: string[]): Promise<YoutubeVideo[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < videoIds.length; i += 50)
      chunks.push(videoIds.slice(i, i + 50));

    const results: YoutubeVideo[] = [];
    for (const chunk of chunks) {
      const res = await this.get<YoutubeApiResponse<YoutubeVideo>>('/videos', {
        part: 'snippet,statistics,contentDetails,liveStreamingDetails',
        id: chunk.join(','),
        maxResults: 50,
      });
      results.push(...(res.data?.items ?? []));
    }
    return results;
  }

  async searchByQuery(
    query: string,
    publishedAfter?: string,
    pageToken?: string,
  ): Promise<YoutubeApiResponse<YoutubeSearchItem>> {
    const res = await this.get<YoutubeApiResponse<YoutubeSearchItem>>(
      '/search',
      {
        q: query,
        part: 'snippet',
        type: 'video',
        order: 'date',
        publishedAfter,
        maxResults: 50,
        pageToken,
      },
    );
    return res.data;
  }
}
