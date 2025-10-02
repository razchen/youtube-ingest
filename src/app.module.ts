import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YoutubeIngestModule } from './youtube-ingest/youtube-ingest.module';
import { Thumbnail } from './youtube-ingest/thumbnail.entity';

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
    YoutubeIngestModule,
  ],
})
export class AppModule {}
