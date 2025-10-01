import { Column, Entity, PrimaryColumn, Index } from 'typeorm';

@Entity({ name: 'thumbnails' })
export class Thumbnail {
  @PrimaryColumn({ type: 'text' })
  videoId!: string;

  @Index()
  @Column({ type: 'text' })
  channelId!: string;

  @Column({ type: 'text' })
  channelTitle!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  publishedAt!: string; // ISO

  @Column({ type: 'bigint' })
  views!: number;

  @Column({ type: 'bigint', nullable: true })
  likes!: number | null;

  @Column({ type: 'bigint' })
  subscribers!: number;

  @Column({ type: 'text' })
  thumbnail_savedPath!: string;

  @Column({ type: 'text' })
  thumbnail_src!: string;

  @Column({ type: 'int', nullable: true })
  thumbnail_nativeW!: number | null;

  @Column({ type: 'int', nullable: true })
  thumbnail_nativeH!: number | null;

  @Column({ type: 'int', nullable: true })
  ocr_charCount!: number | null;

  @Column({ type: 'double', nullable: true })
  ocr_areaPct!: number | null;

  @Column({ type: 'double', nullable: true })
  engagementScore!: number | null;

  @Index({ unique: false })
  @Column({ type: 'text' })
  hash_pHash!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  hash_sha256!: string;

  @Column({ type: 'enum', enum: ['train', 'val', 'test'] })
  split!: 'train' | 'val' | 'test';

  @Column({ type: 'text' })
  fetchedAt!: string;

  // ---- Future nullable fields ----
  @Column({ type: 'text', nullable: true })
  categoryId!: string | null;

  @Column({ type: 'longtext', nullable: true })
  tags_json!: string | null;

  @Column({ type: 'int', nullable: true })
  durationSec!: number | null;

  @Column({ type: 'tinyint', nullable: true })
  isLive!: number | null;

  @Column({ type: 'tinyint', nullable: true })
  madeForKids!: number | null;

  @Column({ type: 'longtext', nullable: true })
  faces_json!: string | null;

  @Column({ type: 'longtext', nullable: true })
  objects_json!: string | null;

  @Column({ type: 'longtext', nullable: true })
  palette_json!: string | null;

  @Column({ type: 'double', nullable: true })
  contrast!: number | null;

  @Column({ type: 'double', nullable: true })
  entropy!: number | null;

  @Column({ type: 'longtext', nullable: true })
  saliency_json!: string | null;

  @Column({ type: 'text', nullable: true })
  channelCountry!: string | null;

  @Column({ type: 'longtext', nullable: true })
  flags_json!: string | null;

  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  @Column({ type: 'longtext', nullable: true })
  notes!: string | null;
}
