import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { YoutubeIngestService } from '../youtube-ingest/youtube-ingest.service';
import minimist, { ParsedArgs } from 'minimist';

// Examples:
// npm run ingest -- --channels UCX6OQ3DkcsbYNE6H8uQQuVA,@mrbeast,veritasium --after 2025-08-01 --max 10
// npm run ingest -- --handles @marquesbrownlee,@linustechtips --max 25
// npm run ingest -- --queries "cat videos, dog videos"
// npm run ingest -- --max 10

function splitIdsAndHandles(items: string[] | undefined) {
  if (!items?.length)
    return {
      ids: undefined as string[] | undefined,
      handles: undefined as string[] | undefined,
    };
  const ids: string[] = [];
  const handles: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    // Channel ID pattern: "UC" + 22 chars (A–Z a–z 0–9 _ -)
    if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) {
      ids.push(s);
    } else {
      // everything else we treat as a handle candidate (accepts "@foo" or "foo")
      handles.push(s);
    }
  }
  return {
    ids: ids.length ? ids : undefined,
    handles: handles.length ? handles : undefined,
  };
}

(async () => {
  const argv: ParsedArgs = minimist(process.argv.slice(2));

  const channelsArg = (argv.channels || argv.c || '') as string;
  const handlesArg = (argv.handles || argv.H || '') as string; // NEW: explicit handles flag
  const after = (argv.after || argv.a) as string | undefined;
  const queriesArg = (argv.queries || argv.q || '') as string;
  const max = argv.max ? Number(argv.max) : undefined;

  const toList = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const channelsList = channelsArg ? toList(channelsArg) : undefined;
  const handlesList = handlesArg ? toList(handlesArg) : undefined;

  // If --channels contains a mix, split them; merge with explicit --handles
  const { ids: channelIdsFromChannels, handles: handlesFromChannels } =
    splitIdsAndHandles(channelsList);
  const channelIds = channelIdsFromChannels;
  const channelHandles = [
    ...(handlesFromChannels ?? []),
    ...(handlesList ?? []),
  ].length
    ? Array.from(
        new Set([...(handlesFromChannels ?? []), ...(handlesList ?? [])]),
      )
    : undefined;

  const queries = queriesArg ? toList(queriesArg) : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const svc = app.get(YoutubeIngestService);
    const summary = await svc.runIngest({
      channelIds, // UC… ids (optional)
      channelHandles, // @handles or bare handles (optional)
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
