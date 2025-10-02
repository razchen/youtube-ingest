import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { YoutubeIngestService } from '../youtube-ingest/youtube-ingest.service';
import minimist, { ParsedArgs } from 'minimist';

// Examples:
// npm run ingest -- --discover-only --handles @mrbeast,@veritasium
// npm run ingest -- --from-db --statuses idle,queued --max 3
// npm run ingest -- --channels @mrbeast,@mkbhd --max 100
// npm run ingest -- --queries "cat videos,dog videos" --after 2025-08-01

function splitIdsAndHandles(items: string[] | undefined) {
  if (!items?.length)
    return {
      ids: undefined as string[] | undefined,
      handles: undefined as string[] | undefined,
    };
  const handles: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;

    handles.push(s);
  }
  return {
    handles: handles.length ? handles : undefined,
  };
}

(async () => {
  const argv: ParsedArgs = minimist(process.argv.slice(2));
  const channelsArg = (argv.channels || argv.c || '') as string;
  const handlesArg = (argv.handles || argv.H || '') as string;
  const after = (argv.after || argv.a) as string | undefined;
  const max = argv.max ? Number(argv.max) : undefined;

  const fromDb = Boolean(argv['from-db']);
  const discoverOnly = Boolean(argv['discover-only']);
  const statusesArg = (argv.statuses || '') as string; // e.g. idle,queued
  const limit = argv.limit ? Number(argv.limit) : undefined;

  const toList = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const channelsList = channelsArg ? toList(channelsArg) : undefined;
  const handlesList = handlesArg ? toList(handlesArg) : undefined;

  const { handles: handlesFromChannels } = splitIdsAndHandles(channelsList);

  const inputHandles = Array.from(
    new Set([...(handlesFromChannels ?? []), ...(handlesList ?? [])]),
  );

  // const queries = queriesArg ? toList(queriesArg) : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const svc = app.get(YoutubeIngestService);

    // 0) Legacy "queries" mode: preserve your old behavior by calling runIngest
    // if (queries?.length) {
    //   const summary = await svc.runIngest({
    //     channelIds: inputIds.length ? inputIds : undefined,
    //     channelHandles: inputHandles.length ? inputHandles : undefined,
    //     queries,
    //     publishedAfter: after,
    //     maxVideosPerChannel: max,
    //   });
    //   console.log(JSON.stringify(summary, null, 2));
    //   return;
    // }

    // 1) Discover only: resolve & upsert channels, then exit
    if (discoverOnly) {
      if (!inputHandles.length) {
        console.error('discover-only requires --handles');
        process.exit(2);
      }
      const res = await svc.discoverChannelsFromHandles(inputHandles);
      console.log(
        JSON.stringify(
          {
            mode: 'discover-only',
            resolved: res.resolvedIds.length,
            notFound: res.notFound,
            errors: res.errors,
            channelIds: res.resolvedIds,
          },
          null,
          2,
        ),
      );
      return;
    }

    // 2) From DB selection
    if (fromDb) {
      const statuses = statusesArg
        ? (toList(statusesArg).filter((s) =>
            ['idle', 'queued', 'running', 'done', 'error'].includes(s),
          ) as Array<'idle' | 'queued' | 'running' | 'done' | 'error'>)
        : undefined;

      const summary = await svc.runIngestFromDb({
        statuses,
        limit,
        publishedAfter: after,
        maxVideosPerChannel: max,
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
  } finally {
    await app.close();
  }
})().catch((err) => {
  console.error('Fatal error in CLI:', err);
  process.exit(1);
});
