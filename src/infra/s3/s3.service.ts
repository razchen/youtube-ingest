import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';
import * as path from 'path';

@Injectable()
export class S3Service {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly cfg: ConfigService) {
    this.region = this.cfg.getOrThrow<string>('S3_REGION');
    this.bucket = this.cfg.getOrThrow<string>('S3_BUCKET');
    this.s3 = new S3Client({
      region: this.region,
    });
  }

  /**
   * Upload a local file to S3.
   * Returns the S3 key and a public URL (works if bucket has a public-read policy or via CloudFront).
   */
  async uploadFile(
    localFilePath: string,
    key: string,
    contentType = this.guessContentType(localFilePath),
    cacheControl = 'public, max-age=31536000, immutable',
  ): Promise<{ key: string; url: string }> {
    const Body = createReadStream(localFilePath);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );

    return { key, url: this.publicUrl(key) };
  }

  publicUrl(key: string) {
    // If you have CloudFront, replace with your CF domain.
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodeURI(
      key,
    )}`;
  }

  private guessContentType(p: string) {
    const ext = path.extname(p).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
  }
}
