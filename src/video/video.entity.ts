// videos.entity.ts
import { Column, Entity, PrimaryColumn, Index } from 'typeorm';

@Entity({ name: 'videos' })
export class Video {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  videoId!: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  channelId!: string;

  // Basic
  @Column({ type: 'text' }) title!: string;
  @Index()
  @Column({ type: 'datetime' })
  publishedAt!: Date;

  // Stats
  @Column({ type: 'bigint', nullable: true }) viewCount!: number | null;
  @Column({ type: 'bigint', nullable: true }) likeCount!: number | null;

  // Content details
  @Column({ type: 'int', nullable: true }) durationSec!: number | null;
  @Column({ type: 'tinyint', nullable: true }) madeForKids!: number | null;
  @Column({ type: 'varchar', length: 32, nullable: true }) categoryId!:
    | string
    | null;

  // Thumbnails (fast filters)
  @Column({ type: 'int', nullable: true }) thumb_max_w!: number | null;
  @Column({ type: 'int', nullable: true }) thumb_max_h!: number | null;
  @Column({ type: 'text', nullable: true }) thumb_max_url!: string | null;
  @Column({ type: 'int', nullable: true }) thumb_high_w!: number | null;
  @Column({ type: 'int', nullable: true }) thumb_high_h!: number | null;
  @Column({ type: 'text', nullable: true }) thumb_high_url!: string | null;
  @Index()
  @Column({ type: 'tinyint', default: 0 })
  has_720p_plus!: number; // 0/1

  // Shorts detection (by redirect only, as requested)
  @Index()
  @Column({ type: 'tinyint', default: 0 })
  is_short!: number; // 0/1

  // Engagement (catalog)
  @Index()
  @Column({ type: 'double', nullable: true })
  engagement!: number | null;

  // Caching API data to avoid re-fetch
  @Column({ type: 'text', nullable: true }) etag!: string | null;
  @Column({ type: 'longtext', nullable: true }) api_snippet_json!:
    | string
    | null;
  @Column({ type: 'longtext', nullable: true }) api_statistics_json!:
    | string
    | null;
  @Column({ type: 'longtext', nullable: true }) api_contentDetails_json!:
    | string
    | null;
  @Column({ type: 'longtext', nullable: true }) api_full_json!: string | null;

  @Column({ type: 'datetime' }) fetchedAt!: Date;
}
