import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { YoutubeIngestService } from '../youtube-ingest/youtube-ingest.service';
import minimist, { ParsedArgs } from 'minimist';

// npm run ingest -- --channels UCX6OQ3DkcsbYNE6H8uQQuVA,UCcLYOTz3ct6_lk9iLToxxAw --after 2025-08-01 --max 10
// npm run ingest -- --queries "cat videos, dog videos"
// npm run ingest -- --max 10

(async () => {
  const argv: ParsedArgs = minimist(process.argv.slice(2));
  const channelsArg = (argv.channels || argv.c || '') as string;
  const after = (argv.after || argv.a) as string | undefined;
  const queriesArg = (argv.queries || argv.q || '') as string;
  const max = argv.max ? Number(argv.max) : undefined;

  const channelIds = channelsArg
    ? channelsArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const queries = queriesArg
    ? queriesArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const svc = app.get(YoutubeIngestService);
    const summary = await svc.runIngest({
      channelIds,
      queries,
      publishedAfter: after,
      maxVideosPerChannel: max,
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
})().catch((err) => {
  console.error('Fatal error in CLI:', err);
  process.exit(1);
});
