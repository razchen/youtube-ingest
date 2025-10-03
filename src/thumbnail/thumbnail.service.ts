import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Thumbnail } from './thumbnail.entity';
import { Video } from '../video/video.entity';

@Injectable()
export class ThumbnailService {
  constructor(
    @InjectRepository(Thumbnail)
    private readonly thumbnailRepo: Repository<Thumbnail>,
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
  ) {}
}
