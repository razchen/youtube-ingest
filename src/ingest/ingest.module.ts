import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestService } from './ingest.service';
import { Thumbnail } from '@/thumbnail/thumbnail.entity';
import { YoutubeClient } from '@/integrations/youtube/youtube.client';
import { ChannelService } from '@/channel/channel.service';
import { Channel } from '@/channel/channel.entity';
import { Video } from '@/video/video.entity';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    TypeOrmModule.forFeature([Thumbnail, Channel, Video]),
  ],
  providers: [ChannelService, IngestService, YoutubeClient],
  exports: [IngestService],
})
export class IngestModule {}
