// src/youtube-ingest/channel.entity.ts
import { Column, Entity, OneToMany, PrimaryColumn, Index } from 'typeorm';
import { Thumbnail } from './thumbnail.entity';

export type ChannelScrapeStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'done'
  | 'error';

@Entity({ name: 'channels' })
export class Channel {
  /** Canonical YouTube channel id (e.g., UCxxxxxxxxxxxxxxxxxxxxxx) */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  /** Optional: @handle or bare handle */
  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  handle!: string | null;

  /** Optional: legacy username */
  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  username!: string | null;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'bigint', default: 0 })
  subscribers!: number;

  /** Useful metadata (nullable = easy to backfill incrementally) */
  @Column({ type: 'bigint', nullable: true })
  viewsCount!: number | null;

  @Column({ type: 'bigint', nullable: true })
  videosCount!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  uploadsPlaylistId!: string | null;

  @Column({ type: 'text', nullable: true })
  country!: string | null;

  @Column({ type: 'longtext', nullable: true })
  topicCategories_json!: string | null;

  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  /** Tracking ingestion state */
  @Index()
  @Column({ type: 'text', nullable: true })
  lastIngestAt!: string | null; // ISO

  @Index()
  @Column({ type: 'text', nullable: true })
  lastVideoPublishedAt!: string | null; // ISO of most recent video seen

  @Index()
  @Column({
    type: 'enum',
    enum: ['idle', 'queued', 'running', 'done', 'error'],
    default: 'idle',
  })
  scrapeStatus!: ChannelScrapeStatus;

  @Column({ type: 'longtext', nullable: true })
  scrapeError!: string | null;

  /** Relationship (optional now; doesn't break existing code) */
  @OneToMany(() => Thumbnail, (t) => t.channel)
  thumbnails!: Thumbnail[];
}
