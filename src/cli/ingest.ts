import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { IngestService } from '@/ingest/ingest.service'; // (if you still use it elsewhere)
import { ChannelService } from '@/channel/channel.service';
import { VideosService } from '@/video/video.service'; // NEW
import minimist, { ParsedArgs } from 'minimist';

function splitHandles(items?: string[]) {
  if (!items?.length) return { handles: undefined as string[] | undefined };
  const handles = items.map((s) => s.trim()).filter(Boolean);
  return { handles: handles.length ? handles : undefined };
}

(async () => {
  const argv: ParsedArgs = minimist(process.argv.slice(2));

  // Discovery from JSON
  const discoverJson = (argv['discover-json'] ||
    argv['json-file'] ||
    argv.J) as string | undefined;

  // Channel/handle inputs
  const channelsArg = (argv.channels || argv.c || '') as string;
  const handlesArg = (argv.handles || argv.H || '') as string;

  // Old “ingest from DB” flags (if you still use IngestService.runIngestFromDb)
  const after = (argv.after || argv.a) as string | undefined;
  const max = argv.max ? Number(argv.max) : undefined;
  const statusesArg = (argv.statuses || '') as string; // e.g. idle,queued
  const limit = argv.limit ? Number(argv.limit) : undefined;
  const discoverOnly = Boolean(argv['discover-only']);

  // catalog & enrich flags
  const catalogFromDb = Boolean(argv['catalog-from-db']); // run VideosService.runIngestFromDb
  const enrichEligible = Boolean(argv['enrich-eligible']); // run YoutubeIngestService.runEnrichEligible
  const sinceDays = argv['since'] ? Number(argv['since']) : 365; // for enrich
  const pageSize = argv['page-size'] ? Number(argv['page-size']) : 1000;
  const concurrency = argv['concurrency'] ? Number(argv['concurrency']) : 3;

  const toList = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const channelsList = channelsArg ? toList(channelsArg) : undefined;
  const handlesList = handlesArg ? toList(handlesArg) : undefined;

  const { handles: handlesFromChannels } = splitHandles(channelsList);
  const inputHandles = Array.from(
    new Set([...(handlesFromChannels ?? []), ...(handlesList ?? [])]),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const ingestService = app.get(IngestService);
    const channelService = app.get(ChannelService);
    const videosService = app.get(VideosService); // NEW

    // 0) Discover channels from JSON file
    if (discoverJson) {
      const summary = await channelService.discoverFromJson(discoverJson);
      console.log(
        JSON.stringify({ mode: 'discover-json', ...summary }, null, 2),
      );
      return;
    }

    // 1) Discover only
    if (discoverOnly) {
      if (!inputHandles.length) {
        console.error('discover-only requires --handles');
        process.exit(2);
      }
      const summary = await channelService.discoverFromHandles(inputHandles);
      console.log(
        JSON.stringify({ mode: 'discover-only', ...summary }, null, 2),
      );
      return;
    }

    // 2) Catalog from DB (videos pass: catalog + score + shorts-by-redirect)
    if (catalogFromDb) {
      // mirrors your earlier runIngestFromDb signature in VideosService
      const summary = await videosService.runIngestFromDb({
        statuses: statusesArg
          ? (toList(statusesArg).filter((s) =>
              ['idle', 'queued', 'running', 'done', 'error'].includes(s),
            ) as Array<'idle' | 'queued' | 'running' | 'done' | 'error'>)
          : undefined,
        limit,
        publishedAfter: after, // optional ISO or YYYY-MM-DD
        maxVideosPerChannel: max, // treat as list cap (not fetch cap)
      });
      console.log(
        JSON.stringify({ mode: 'catalog-from-db', ...summary }, null, 2),
      );
      return;
    }

    // 3) Enrich eligible (heavy pass; no YouTube API calls)
    if (enrichEligible) {
      const summary = await ingestService.runEnrichEligible({
        sinceDays,
        pageSize,
        concurrency,
      });
      console.log(
        JSON.stringify({ mode: 'enrich-eligible', ...summary }, null, 2),
      );
      return;
    }

    // 5) Help
    console.error(
      [
        'No mode selected. Examples:',
        '  # Discover channels from JSON',
        '  npm run ingest -- --discover-json ./data/parsed/us-channels.json',
        '  # Discover only via handles',
        '  npm run ingest -- --discover-only --handles @example1,@example2',
        '  # Catalog pass (videos) from DB selection',
        '  npm run ingest -- --catalog-from-db --statuses idle,queued --after 2020-01-01 --max 1000',
        '  # Enrich pass (eligible only)',
        '  npm run ingest -- --enrich-eligible --since 365 --page-size 1000 --concurrency 3',
      ].join('\n'),
    );
    process.exit(2);
  } finally {
    await app.close();
  }
})().catch((err) => {
  console.error('Fatal error in CLI:', err);
  process.exit(1);
});
