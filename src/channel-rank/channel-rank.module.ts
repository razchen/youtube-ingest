// src/channel-rank/channel-rank.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '@/channel/channel.entity';
import { Video } from '@/video/video.entity';
import { ChannelRankService } from './channel-rank.service';
import { ChannelRankController } from './channel-rank.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Channel, Video])],
  controllers: [ChannelRankController],
  providers: [ChannelRankService],
})
export class ChannelRankModule {}
