export interface YoutubeThumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface YoutubeSnippet {
  title?: string;
  publishedAt?: string;
  channelId?: string;
  channelTitle?: string;
  thumbnails?: {
    default?: YoutubeThumbnail;
    medium?: YoutubeThumbnail;
    high?: YoutubeThumbnail;
    standard?: YoutubeThumbnail;
    maxres?: YoutubeThumbnail;
  };
  categoryId?: string;
  madeForKids?: boolean;
}

export interface YoutubeStatistics {
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
  subscriberCount?: string;
  videoCount?: string;
}

export interface YoutubeContentDetails {
  duration?: string;
}

export interface YoutubeChannel {
  id: string;
  etag?: string;
  snippet?: { title?: string };
  statistics?: YoutubeStatistics;
  contentDetails?: { relatedPlaylists?: { uploads: string } };
}

export interface YoutubeVideo {
  id: string;
  snippet?: YoutubeSnippet;
  statistics?: YoutubeStatistics;
  contentDetails?: YoutubeContentDetails;
  liveStreamingDetails?: {
    actualStartTime?: string;
    scheduledStartTime?: string;
  };
  etag?: string;
}

export interface YoutubeSearchItem {
  id?: { videoId?: string };
  snippet?: YoutubeSnippet;
}

export interface YoutubeApiResponse<T> {
  items?: T[];
  nextPageToken?: string;
  etag?: string;
}
