import { Controller, Get } from '@nestjs/common';
import { ThumbnailService } from './thumbnail.service';
import { PaginationRequest } from '../types/pagination';
import { Thumbnail } from './thumbnail.entity';
import { Query } from '@nestjs/common';
import { PaginationResponse } from '../types/pagination';

@Controller('admin/thumbnails')
export class ThumbnailController {
  constructor(private readonly thumbnailService: ThumbnailService) {}

  @Get('/')
  async findAll(
    @Query() query: PaginationRequest,
  ): Promise<PaginationResponse<Thumbnail>> {
    return await this.thumbnailService.findAll(query.page, query.limit);
  }
}
