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
  rowsUpserted: number;
  imagesSaved: number;
  tookSec: number;
  imageDir: string;
}

export type IngestAccumulators = {
  videosSeen: { value: number };
  imagesSaved: { value: number };
  rowsUpserted: { value: number };
};
