import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import { CaptionAnalysis, ThumbnailService } from './thumbnail.service';

type SaveCaptionBody = CaptionAnalysis & { channelVideoId: string };

@Controller('thumbnails/caption')
export class ThumbnailCaptionController {
  constructor(private readonly thumbnailService: ThumbnailService) {}

  @Get('next')
  async next() {
    const job = await this.thumbnailService.getNextUncaptioned();
    if (!job) throw new HttpException('', HttpStatus.NO_CONTENT);
    return job; // Nest will json-serialize it with 200 OK
  }

  @Post('result')
  @HttpCode(200)
  async result(@Body() body: SaveCaptionBody) {
    const { ...analysis } = body;
    const out = await this.thumbnailService.saveCaptionAnalysis(analysis);
    return out;
  }
}
