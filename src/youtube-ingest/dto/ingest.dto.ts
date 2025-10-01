import { IsArray, IsISO8601, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class IngestDto {
  @IsOptional()
  @IsArray()
  @Type(() => String)
  channelIds?: string[];

  @IsOptional()
  @IsArray()
  @Type(() => String)
  queries?: string[];

  @IsOptional()
  @IsISO8601()
  publishedAfter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxVideosPerChannel?: number;
}
