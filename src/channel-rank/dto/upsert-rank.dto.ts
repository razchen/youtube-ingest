// src/channel-rank/dto/upsert-rank.dto.ts
import { IsInt, Min, Max, IsString, Length } from 'class-validator';

export class UpsertChannelRankDto {
  @IsString()
  @Length(1, 64)
  channelId!: string;

  @IsInt()
  @Min(0)
  @Max(5)
  score!: number;
}
