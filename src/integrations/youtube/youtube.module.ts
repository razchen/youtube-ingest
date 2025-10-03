import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { YoutubeClient } from './youtube.client';

@Global() // make available app-wide without re-exporting everywhere (optional but handy)
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: YoutubeClient,
      useFactory: (cfg: ConfigService) => new YoutubeClient(cfg), // your existing ctor
      inject: [ConfigService],
    },
  ],
  exports: [YoutubeClient],
})
export class YoutubeModule {}
