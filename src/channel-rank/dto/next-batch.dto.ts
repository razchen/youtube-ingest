// src/channel-rank/dto/next-batch.dto.ts
export type CandidateThumbDto = {
  thumbnailId: string;
  videoId: string;
  imageUrl: string;
  width: number;
  height: number;
  engagement: number | null;
};

export type ChannelWithCandidatesDto = {
  channelId: string;
  channelTitle: string;
  subscribers: number;
  items: CandidateThumbDto[]; // up to 9
};

export type NextBatchResponseDto = {
  items: ChannelWithCandidatesDto[]; // up to limit (default 30)
  offset: number;
  limit: number;
  order: 'subscribers_desc' | 'recent_activity' | 'none';
};
