import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { YoutubeIngestService } from '../youtube-ingest/youtube-ingest.service';
import { ChannelService } from '../youtube-ingest/channel.service';
import minimist, { ParsedArgs } from 'minimist';

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
  return { handles: handles.length ? handles : undefined };
}

(async () => {
  const argv: ParsedArgs = minimist(process.argv.slice(2));

  // NEW: discover from JSON file
  const discoverJson = (argv['discover-json'] ||
    argv['json-file'] ||
    argv.J) as string | undefined;

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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const youtubeIngestService = app.get(YoutubeIngestService);
    const channelService = app.get(ChannelService);

    // 0) NEW: Discover channels from a JSON file with {handle,country?,categories?}
    if (discoverJson) {
      const summary = await channelService.discoverFromJson(discoverJson);
      console.log(
        JSON.stringify({ mode: 'discover-json', ...summary }, null, 2),
      );
      return;
    }

    // 1) Discover only: resolve & upsert channels, then exit
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

    // 2) From DB selection
    if (fromDb) {
      const statuses = statusesArg
        ? (toList(statusesArg).filter((s) =>
            ['idle', 'queued', 'running', 'done', 'error'].includes(s),
          ) as Array<'idle' | 'queued' | 'running' | 'done' | 'error'>)
        : undefined;

      const summary = await youtubeIngestService.runIngestFromDb({
        statuses,
        limit,
        publishedAfter: after,
        maxVideosPerChannel: max,
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    // 3) No mode matched → show quick help
    console.error(
      [
        'No mode selected. Examples:',
        '  npm run ingest -- --discover-json ./data/parsed/handles_us_travel.json',
        '  npm run ingest -- --discover-only --handles @milashaumkabest',
        '  npm run ingest -- --from-db --statuses idle,queued --max 3',
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
