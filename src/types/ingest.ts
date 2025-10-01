export interface IngestParams {
  channelIds?: string[];
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
  jsonlPath: string;
  csvPath: string;
  imageDir: string;
}
