import { Body, Controller, Post } from '@nestjs/common';
import { YoutubeIngestService } from './youtube-ingest.service';
import { IngestDto } from './dto/ingest.dto';

@Controller('ingest')
export class YoutubeIngestController {
  constructor(private readonly svc: YoutubeIngestService) {}

  @Post()
  async postIngest(@Body() body: IngestDto) {
    const summary = await this.svc.runIngest({
      channelIds: body.channelIds,
      queries: body.queries,
      publishedAfter: body.publishedAfter,
      maxVideosPerChannel: body.maxVideosPerChannel,
    });
    return summary;
  }
}
