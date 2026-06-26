import { z } from "zod";

export const createUploadSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  content_type: z.enum([
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/webm"
  ]),
  size_bytes: z.number().int().positive(),
  project_id: z.uuid().optional()
});

export const completeUploadSchema = z.object({
  parts: z.array(z.object({
    part_number: z.number().int().min(1).max(10000),
    etag: z.string().trim().min(1).max(500)
  })).min(1).max(10000),
  checksum_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
});
