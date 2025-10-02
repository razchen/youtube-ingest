import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YoutubeIngestService } from './youtube-ingest.service';
import { Thumbnail } from './thumbnail.entity';
import { YoutubeClient } from './youtube.client';
import { Channel } from './channel.entity';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    TypeOrmModule.forFeature([Thumbnail, Channel]),
  ],
  providers: [YoutubeIngestService, YoutubeClient],
  exports: [YoutubeIngestService],
})
export class YoutubeIngestModule {}
