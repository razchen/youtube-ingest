export interface IngestParams {
  channelIds?: string[];
  channelHandles?: string[];
  queries?: string[];
  publishedAfter?: string;
  maxVideosPerChannel?: number;
}

export interface IngestSummary {
  channelsProcessed: number;
  videosSeen: number;
  imagesSaved: number;
  rowsUpserted: number;
  tookSec: number;
  imageDir: string;
}
