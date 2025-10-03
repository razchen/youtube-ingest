import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestModule } from './ingest/ingest.module';
import { Thumbnail } from './thumbnail/thumbnail.entity';
import { ChannelModule } from './channel/channel.module';
import { VideosModule } from './video/video.module';
import { ThumbnailModule } from './thumbnail/thumbnail.module';
import { YoutubeModule } from './integrations/youtube/youtube.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'mysql',
        host: cfg.get('DB_HOST', '127.0.0.1'),
        port: Number(cfg.get('DB_PORT', '3306')),
        username: cfg.get('DB_USER', 'root'),
        password: cfg.get('DB_PASS', ''),
        database: cfg.get('DB_NAME', 'thumbs'),
        entities: [Thumbnail],
        synchronize: true, // OK for MVP; switch to migrations for prod
        charset: 'utf8mb4',
        autoLoadEntities: true,
      }),
    }),
    YoutubeModule,

    ChannelModule,
    VideosModule,
    ThumbnailModule,
    IngestModule,
  ],
})
export class AppModule {}
