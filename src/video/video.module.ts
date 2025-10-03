import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './video.entity';
import { VideosService } from './video.service';
import { YoutubeClient } from '@/integrations/youtube/youtube.client'; // adjust path if different
import { ConfigModule } from '@nestjs/config';
import { Channel } from '@/channel/channel.entity';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Channel, Video])],
  providers: [VideosService, YoutubeClient],
  exports: [VideosService],
})
export class VideosModule {}
