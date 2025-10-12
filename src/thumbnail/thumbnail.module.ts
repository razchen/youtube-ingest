import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Thumbnail } from './thumbnail.entity';
import { YoutubeClient } from '@/integrations/youtube/youtube.client'; // adjust path if different
import { ConfigModule } from '@nestjs/config';
import { ThumbnailService } from './thumbnail.service';
import { Video } from '@/video/video.entity';
import { ThumbnailCaptionController } from './caption.controller';
import { ThumbnailController } from './thumbnail.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Thumbnail, Video])],
  controllers: [ThumbnailCaptionController, ThumbnailController],
  providers: [ThumbnailService, YoutubeClient],
  exports: [ThumbnailService],
})
export class ThumbnailModule {}
