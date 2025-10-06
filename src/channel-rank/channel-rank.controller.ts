// src/channel-rank/channel-rank.controller.ts
import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ChannelRankService } from './channel-rank.service';
import { UpsertChannelRankDto } from './dto/upsert-rank.dto';
import { NextBatchResponseDto } from './dto/next-batch.dto';

@Controller('admin/channel-rank')
export class ChannelRankController {
  constructor(private readonly svc: ChannelRankService) {}

  /**
   * Fetch a batch of unranked channels with their best-9 thumbnails each.
   * Query:
   *  - offset?: number (default 0)
   *  - limit?: number (default 30; max 100)
   *  - order?: 'subscribers_desc' | 'recent_activity' | 'none' (default 'subscribers_desc')
   */
  @Get('next-batch')
  async nextBatch(
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('order') order?: 'subscribers_desc' | 'recent_activity' | 'none',
  ): Promise<NextBatchResponseDto> {
    const off = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    const lim = Number.isFinite(Number(limit)) ? Number(limit) : 30;
    return this.svc.getNextUnrankedBatch({ offset: off, limit: lim, order });
  }

  /**
   * Set rank for a single channel.
   * Body: { channelId: string, score: 0..5 }
   */
  @Post()
  async upsert(@Body() dto: UpsertChannelRankDto) {
    return this.svc.setRankScore(dto.channelId, dto.score);
  }
}
