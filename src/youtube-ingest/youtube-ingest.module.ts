import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YoutubeIngestController } from './youtube-ingest.controller';
import { YoutubeIngestService } from './youtube-ingest.service';
import { Thumbnail } from './thumbnail.entity';
import { YoutubeClient } from './youtube.client';

@Module({
  imports: [ConfigModule, HttpModule, TypeOrmModule.forFeature([Thumbnail])],
  providers: [YoutubeIngestService, YoutubeClient],
  controllers: [YoutubeIngestController],
  exports: [YoutubeIngestService],
})
export class YoutubeIngestModule {}
