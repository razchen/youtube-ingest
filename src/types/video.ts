export interface VideoSummary {
  channelsProcessed: number;
  videosSeen: number;
  rowsUpserted: number;
  tookSec: number;
}

export type VideoAccumulators = {
  videosSeen: { value: number };
  rowsUpserted: { value: number };
};
