# Creator Studio AI — Development Roadmap Phase 1 sampai Phase 3

Dokumen ini merangkum pengembangan **Creator Studio AI** dari Phase 1 sampai Phase 3. Urutan pengembangan dirancang agar fondasi sistem stabil terlebih dahulu, kemudian dilanjutkan dengan Auto Clipping MVP yang dapat berjalan end-to-end, lalu ditingkatkan menjadi sistem clipping yang lebih cerdas dan profesional.

---

# Ringkasan Tahapan

```text
Phase 1 — Foundation
Auth, RBAC, database, upload, job framework, Temporal, observability dasar
        ↓
Phase 2 — Auto Clipping MVP
Video panjang → transcript → analisis AI → clip → subtitle → render
        ↓
Phase 3 — Advanced Clipping
Active speaker, advanced reframing, editor, brand kit, dan regenerate per clip
```

---

# Phase 1 — Foundation

## Tujuan

Membangun fondasi aplikasi yang aman, scalable, mudah dipelihara, dan siap menjalankan proses background dengan durasi panjang.

Phase 1 belum berfokus pada pemrosesan video secara lengkap. Fase ini memastikan autentikasi, otorisasi, database, upload media, job management, Temporal, dan observability sudah siap sebelum pipeline AI dan video dibangun.

## 1. Monorepo dan Struktur Project

Membuat monorepo dengan struktur utama:

```text
creator-studio-ai/
├── apps/
│   ├── web-node/
│   ├── media-ingestion-node/
│   └── ai-media-python/
├── packages/
│   ├── contracts/
│   ├── config/
│   └── observability/
├── infra/
├── docs/
├── AGENTS.md
├── CONTRIBUTING.md
├── README.md
├── docker-compose.yml
└── Makefile
```

### Tanggung jawab service

#### `web-node`

- Web application.
- REST API publik.
- EJS rendering.
- Authentication dan session.
- RBAC dan permission.
- User, project, media metadata, dan job management.
- Temporal client.
- Server-Sent Events.
- BullMQ producer dan worker ringan.
- Audit log.

#### `media-ingestion-node`

- Mengambil media dari sumber eksternal yang diizinkan.
- Memvalidasi URL dan metadata.
- Melindungi sistem dari SSRF.
- Mengunduh media.
- Menghitung checksum.
- Mengunggah media ke MinIO.

#### `ai-media-python`

- Temporal Python worker.
- FastAPI internal.
- FFmpeg dan FFprobe.
- Transcription.
- Scene dan silence analysis.
- AI clip analysis.
- Crop, subtitle, rendering, dan quality check.

---

## 2. Authentication

Fitur yang dikembangkan:

- Register dengan email dan password.
- Login email dan password.
- Logout.
- Google OAuth.
- Email verification.
- Forgot password.
- Reset password dengan token satu kali.
- Password hashing menggunakan Argon2id.
- Session rotation setelah login.
- Session rotation setelah perubahan privilege.
- Active session management.
- Revoke session.
- Login history.
- 2FA/TOTP foundation.
- 2FA wajib tersedia untuk superadmin.

### Redirect setelah login

```text
USER       → /app/dashboard
SUPERADMIN → /admin/dashboard
```

---

## 3. Authorization dan RBAC

Membuat sistem:

- Role.
- Permission.
- UserRole.
- RolePermission.
- Permission guard.
- Ownership validation.
- Admin-only route.
- User-only route.

Role awal:

```text
USER
SUPERADMIN
```

Contoh permission:

```text
users.read
users.manage
jobs.read
jobs.manage
jobs.cancel
jobs.retry
providers.manage
models.manage
credentials.manage
audit.read
system.manage
```

### View-as-user

Superadmin dapat membuka user workspace tanpa mengganti role atau session secara diam-diam.

Data yang disimpan:

- Admin actor.
- User target.
- Reason.
- Waktu mulai.
- Waktu selesai.
- IP address.
- User agent.
- Aktivitas selama impersonation.

---

## 4. Security Foundation

Implementasi keamanan:

- HTTP-only cookie.
- Secure cookie untuk production.
- SameSite cookie.
- CSRF protection.
- Helmet.
- Content Security Policy.
- HSTS.
- Rate limiting.
- Global request limit.
- Login endpoint limit.
- Forgot-password endpoint limit.
- Brute-force backoff.
- Account lockout foundation.
- Input validation menggunakan Zod.
- Output escaping pada EJS.
- Secret masking.
- Structured log redaction.
- Internal service authentication foundation.
- Confirmation untuk destructive action.
- Audit log.

Secret yang tidak boleh masuk log:

```text
Authorization header
Cookie
API key
Access token
Refresh token
Password
Signed URL
Client secret
Session identifier
```

---

## 5. PostgreSQL dan Prisma

Membuat Prisma schema untuk entitas minimum:

- User.
- Role.
- Permission.
- UserRole.
- RolePermission.
- Session.
- OAuthAccount.
- PasswordResetToken.
- EmailVerificationToken.
- UserSetting.
- AiProvider.
- AiModel.
- AiModelCapability.
- EncryptedCredential.
- UserAiPreference.
- Project.
- MediaAsset.
- UploadSession.
- Job.
- JobStage.
- JobEvent.
- JobAttempt.
- JobError.
- AutoClipRequest.
- ClipCandidate.
- ClipOutput.
- Transcript.
- TranscriptSegment.
- SubtitleAsset.
- TtsRequest.
- TtsOutput.
- TranscriptionRequest.
- SocialConnection.
- PublishJob.
- PublishDestination.
- Preset.
- BrandKit.
- UsageRecord.
- Quota.
- Plan.
- Notification.
- WebhookEndpoint.
- AuditLog.
- FeatureFlag.
- SystemSetting.

### Aturan database

- Menggunakan UUID.
- Menambahkan index pada `user_id`, `job_id`, `status`, `created_at`, dan `provider_id`.
- Menggunakan optimistic locking pada entity yang rawan concurrent update.
- Menggunakan soft delete hanya pada entity yang perlu dipulihkan.
- Menyimpan binary media di MinIO, bukan PostgreSQL.
- Menyimpan timestamp media dalam integer millisecond.

---

## 6. Redis dan BullMQ

Redis digunakan untuk:

- Session support.
- Rate limiting.
- Cache.
- Distributed lock.
- SSE event distribution.
- BullMQ.

BullMQ digunakan untuk pekerjaan pendek:

- Email.
- Notification.
- Webhook.
- Metadata synchronization.
- Publish status polling.
- Cleanup ringan.

BullMQ tidak digunakan untuk workflow auto clipping utama.

---

## 7. MinIO Multipart Upload

Membuat flow upload besar:

```text
Browser
  ↓ request upload session
Node.js
  ↓ generate presigned multipart URLs
Browser
  ↓ upload langsung
MinIO
  ↓ completion metadata
Node.js
  ↓ validation job
```

Fitur:

- Multipart upload.
- Presigned URL.
- Validasi ukuran file.
- Validasi extension.
- Validasi MIME.
- Checksum.
- Upload ownership.
- Upload expiry.
- Abort incomplete upload.
- Media asset metadata.
- Signed download URL dengan expiry pendek.

Contoh object key:

```text
users/{user_id}/jobs/{job_id}/source/original.mp4
```

---

## 8. Job Framework

Membuat generic job framework dengan state:

```text
DRAFT
UPLOADING
QUEUED
RUNNING
PAUSE_REQUESTED
PAUSED
CANCEL_REQUESTED
CANCELED
FAILED
COMPLETED
PARTIALLY_COMPLETED
NEEDS_REVIEW
```

Fitur:

- Create job.
- Idempotency key.
- Job stage.
- Job attempt.
- Job event.
- Job error.
- Current stage.
- Overall progress.
- Cancel request.
- Retry failed stage.
- Duplicate job.
- Input snapshot.
- Output summary.
- User-friendly error.
- Technical error ID.
- Audit trail.

---

## 9. Temporal Foundation

Membuat koneksi dan fondasi Temporal:

- Temporal TypeScript client.
- Temporal Python worker.
- Namespace dan task queue.
- Workflow starter.
- Workflow ID mapping.
- Signal cancel.
- Signal pause foundation.
- Retry policy.
- Activity timeout.
- Heartbeat foundation.
- Workflow status projection ke PostgreSQL.

Workflow dummy digunakan untuk memvalidasi:

- Workflow dapat dimulai.
- Worker menerima task.
- Progress tersimpan.
- Cancel dapat dikirim.
- Restart worker tidak menghilangkan workflow state.

---

## 10. Progress Real-Time

Menggunakan Server-Sent Events.

Endpoint:

```text
GET /api/v1/jobs/:jobId/events/stream
```

Fallback:

```text
GET /api/v1/jobs/:jobId
GET /api/v1/jobs/:jobId/events
```

Progress event:

```json
{
  "job_id": "uuid",
  "stage": "TRANSCRIBING",
  "stage_progress": 64,
  "overall_progress": 31,
  "message": "Transcribing audio segment 8 of 12",
  "occurred_at": "ISO-8601",
  "metadata": {}
}
```

---

## 11. UI Foundation

Membuat halaman:

### User

- Login.
- Register.
- Forgot password.
- Reset password.
- Dashboard.
- Jobs.
- Media Library.
- Settings.
- Security.

### Admin

- Dashboard.
- Users.
- Roles dan permissions.
- Jobs.
- AI providers.
- Models.
- Platform credentials.
- Audit logs.
- System settings.

UI menggunakan:

- EJS.
- Bootstrap 5.
- Vanilla JavaScript modular.
- Reusable partial.
- Responsive sidebar.
- Toast.
- Modal untuk aksi penting.
- Skeleton loading.
- Empty state.
- Inline validation.
- Indonesia dan English foundation.

---

## 12. Observability Dasar

Membuat:

- Pino structured logging.
- Request ID.
- Trace ID foundation.
- User ID dan job ID correlation.
- OpenTelemetry configuration.
- Prometheus metrics.
- Grafana dashboard foundation.
- Loki integration.
- Health endpoint.
- Readiness endpoint.
- Liveness endpoint.

---

## 13. Docker Compose

Service development:

- `web-node`.
- `media-ingestion-node`.
- `ai-media-python`.
- PostgreSQL.
- Redis.
- MinIO.
- MinIO initialization.
- Temporal.
- Temporal UI.
- Migration service.
- Prometheus.
- Grafana.
- Loki.
- OpenTelemetry Collector.

Migration dijalankan melalui service terpisah:

```text
prisma migrate deploy
```

Web hanya berjalan setelah migration berhasil.

---

## Deliverable Phase 1

Phase 1 dianggap selesai jika:

- User dapat register dan login.
- Superadmin dapat login.
- RBAC berjalan.
- Session dan CSRF berjalan.
- Upload multipart langsung ke MinIO berjalan.
- Job dapat dibuat.
- Temporal workflow dapat dimulai.
- Progress job dapat dilihat melalui SSE.
- Job dapat dicancel dan diretry.
- Audit log tersimpan.
- Docker Compose development tersedia.
- Test inti lulus.

---

# Phase 2 — Auto Clipping MVP

## Tujuan

Membangun pipeline auto clipping end-to-end:

```text
Video panjang
  ↓
Transcription
  ↓
Scene dan silence analysis
  ↓
AI clip candidate analysis
  ↓
Boundary normalization
  ↓
Ranking dan deduplication
  ↓
Crop dan subtitle
  ↓
Final render
  ↓
Quality check
  ↓
Preview dan download
```

---

## 1. Source dan Media Ingestion

Mendukung:

- Upload video.
- Pilih video dari Media Library.
- URL dari sumber yang didukung.

Validasi:

- MIME.
- Extension.
- File size.
- Checksum.
- FFprobe.
- Codec.
- Duration.
- Resolution.
- Audio stream.
- Rotation metadata.
- Hak penggunaan konten.

Python tidak mengunduh media dari internet. URL hanya diproses oleh `media-ingestion-node`.

---

## 2. Auto Clipping Wizard

Membuat wizard maksimal empat langkah:

### Step 1 — Source

- Upload video.
- URL.
- Media Library.
- Project name.
- Language.
- Speaker count.
- Custom vocabulary.
- Content usage confirmation.

### Step 2 — Content Strategy

- Niche.
- Target audience.
- Target platform.
- Objective.
- Tone.
- Desired clip count.
- Minimum duration.
- Maximum duration.
- Minimum viral score.
- Preferred topic.
- Topic to avoid.
- Sensitive topic.
- Hook style.
- CTA preference.
- Profanity handling.
- Remove long silence.
- Remove filler words.

### Step 3 — Visual dan Subtitle

- Aspect ratio.
- Center crop.
- Basic face crop.
- Subtitle style.
- Font.
- Position.
- Max lines.
- Safe margin.
- Watermark.
- Burn-in atau sidecar.

### Step 4 — Review dan Submit

- Source summary.
- Strategy summary.
- Render summary.
- Estimated usage.
- Credential source.
- Submit job.

Mendukung Quick Mode dan Advanced Mode.

---

## 3. Temporal Auto Clipping Workflow

Stage:

```text
VALIDATING_SOURCE
INGESTING_SOURCE
PROBING_MEDIA
EXTRACTING_AUDIO
TRANSCRIBING
DIARIZING_OR_SPEAKER_ANALYSIS
DETECTING_SCENES
DETECTING_SILENCE
ANALYZING_CLIP_CANDIDATES
NORMALIZING_BOUNDARIES
RANKING_AND_DEDUPLICATING
GENERATING_PREVIEWS
REFRAMING
GENERATING_SUBTITLES
RENDERING_FINAL_CLIPS
QUALITY_CHECK
GENERATING_METADATA
UPLOADING_OUTPUTS
COMPLETED
```

Setiap activity wajib memiliki:

- Timeout.
- Retry policy.
- Heartbeat.
- Idempotency key.
- Progress event.
- Cancellation handling.
- Error classification.
- Temporary file cleanup.
- Checkpoint.

---

## 4. FFprobe dan Audio Extraction

Development:

- Membaca metadata media.
- Memvalidasi input.
- Mendeteksi audio stream.
- Mengekstrak audio menggunakan FFmpeg.
- Mengubah audio ke format yang cocok untuk Whisper.
- Menormalisasi audio jika diperlukan.

Contoh output:

```text
users/{user_id}/jobs/{job_id}/working/audio.wav
```

---

## 5. Transcription dengan faster-whisper

Output minimum:

- Detected language.
- Segment timestamp.
- Word timestamp.
- Confidence.
- Raw text.
- Normalized text.
- Speaker label jika tersedia.

Custom vocabulary mendukung:

- Nama orang.
- Brand.
- Singkatan.
- Istilah teknis.
- Nama tempat.

Output:

```text
users/{user_id}/jobs/{job_id}/working/transcript.json
```

---

## 6. Basic Speaker Analysis

Membuat versi dasar:

- Mendeteksi pergantian speaker.
- Memberi label `SPEAKER_01`, `SPEAKER_02`, dan seterusnya.
- Menghubungkan speaker dengan transcript segment.
- Menyediakan speaker metadata untuk crop.

Diarization lanjutan dapat dibuat optional karena membutuhkan resource lebih besar.

---

## 7. Scene Detection

Menggunakan PySceneDetect, FFmpeg, atau OpenCV adapter.

Output:

- Scene ID.
- Start time.
- End time.
- Duration.
- Hard-cut indicator.
- Candidate thumbnail frame.

Scene metadata digunakan untuk:

- Boundary normalization.
- Crop transition.
- Thumbnail.
- Quality check.

---

## 8. Silence Detection

Menggunakan FFmpeg `silencedetect` atau WebRTC VAD.

Digunakan untuk:

- Mendeteksi natural pause.
- Menggeser start dan end clip.
- Menghapus silence panjang.
- Menghindari potongan di tengah kata.
- Memperbaiki pacing clip.

---

## 9. AI Clip Candidate Analyzer

LLM menerima:

- Transcript bertimestamp.
- Scene metadata.
- Silence metadata.
- Speaker metadata.
- Niche.
- Audience.
- Target platform.
- Objective.
- Tone.
- Clip duration.
- Minimum score.
- Preferred topics.
- Topics to avoid.

Komponen viral score:

```text
hook_score              30%
conflict_score          25%
emotion_score           20%
novelty_score           15%
comment_potential_score 10%
```

Rumus:

```text
viral_score =
  hook_score * 0.30 +
  conflict_score * 0.25 +
  emotion_score * 0.20 +
  novelty_score * 0.15 +
  comment_potential_score * 0.10
```

Penalty:

- Context penalty.
- Weak ending penalty.
- Slow start penalty.
- Duplicate penalty.
- Unsafe or misleading penalty.
- Cut quality penalty.

Development teknis:

- AI provider abstraction.
- Structured output.
- JSON schema validation.
- Invalid response repair.
- Retry terbatas.
- Prompt versioning.
- Token usage.
- Latency.
- Provider response ID.
- Audit metadata.

---

## 10. Boundary Normalization

Timestamp dari AI tidak langsung digunakan.

Normalisasi dilakukan berdasarkan:

- Word timestamp.
- Sentence boundary.
- Silence.
- Scene boundary.
- Speaker transition.
- Minimum dan maximum duration.
- Hook position.
- Ending payoff.

Aturan:

- Tidak memotong kata.
- Tidak memulai terlalu lambat.
- Menambahkan pre-roll bila diperlukan.
- Mengakhiri pada kesimpulan, punchline, atau natural pause.
- Menghindari clip yang menggantung.

---

## 11. Ranking dan Deduplication

Development:

- Mengurutkan berdasarkan final viral score.
- Menghapus kandidat dengan timestamp overlap tinggi.
- Menghapus kandidat dengan transcript sangat mirip.
- Memastikan jumlah clip sesuai request.
- Memastikan score memenuhi minimum.
- Menjaga variasi topik dan speaker.
- Menggunakan fallback hanya bila user mengizinkan.

---

## 12. Preview Generation

Menghasilkan preview ringan:

- Resolusi lebih rendah.
- Encode cepat.
- Subtitle sederhana.
- Upload ke MinIO.
- Tampilkan sebelum final download.

Path:

```text
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/preview.mp4
```

---

## 13. Basic Crop dan Reframing

MVP mendukung:

### Center crop

- Landscape ke portrait.
- Crop bagian tengah.
- Aspect ratio 9:16, 1:1, 4:5, atau 16:9.

### Basic face crop

- Deteksi wajah.
- Pilih wajah dominan.
- Crop mengikuti wajah.
- Tracking smoothing dasar.
- Scene-cut-aware reset.

Belum termasuk split-screen dan active speaker tracking tingkat lanjut.

---

## 14. Subtitle Generation

Format:

- SRT.
- VTT.
- ASS.
- JSON timestamp.
- Burn-in subtitle.

Fitur:

- Phrase-aware line breaking.
- Max words per line.
- Max lines.
- Font.
- Font size.
- Text color.
- Background.
- Stroke.
- Shadow.
- Position.
- Safe margin.
- Basic word highlighting.
- Profanity censor.

---

## 15. Final Rendering

Menggunakan FFmpeg untuk:

- Trim source.
- Crop.
- Resize.
- Reframe.
- Burn subtitle.
- Apply watermark.
- Normalize audio.
- Encode video.
- Fast start.
- Generate thumbnail.

Output standar:

```text
Video codec : H.264
Audio codec : AAC
Pixel format: yuv420p
Container   : MP4
```

Path:

```text
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/final.mp4
```

---

## 16. Quality Check

Pemeriksaan:

- File integrity.
- Duration.
- Resolution.
- Aspect ratio.
- Audio stream.
- Black frame.
- Frozen frame.
- Loudness.
- Subtitle overflow.
- Subtitle safe area.
- Corrupt output.
- Truncated ending.

Status:

```text
PASSED
NEEDS_REVIEW
FAILED
```

---

## 17. Metadata Generation

Setiap clip menghasilkan:

- Title.
- Hook.
- Summary.
- Why it works.
- Viral score.
- Score breakdown.
- Caption.
- CTA.
- Hashtag.
- Thumbnail text.
- Source timestamp.
- Speaker.
- Scene.
- Render settings.
- Provider usage.

---

## 18. Halaman Hasil

Menampilkan:

- Video preview.
- Viral score.
- Breakdown score.
- Hook.
- Transcript.
- Source timestamp.
- Suggested title.
- Caption.
- CTA.
- Hashtag.
- Quality status.
- Render configuration.

Action:

- Preview.
- Download video.
- Download subtitle.
- Download metadata.
- Retry failed stage.
- Regenerate clip.
- Duplicate job.
- Download all ZIP.

---

## Deliverable Phase 2

Phase 2 selesai jika:

- User dapat membuat auto clipping job.
- Workflow berjalan melalui Temporal.
- Video dapat diprobe.
- Audio dapat diekstrak.
- Transcript bertimestamp berhasil dibuat.
- Scene dan silence metadata tersedia.
- AI menghasilkan kandidat clip JSON valid.
- Boundary kandidat dinormalisasi.
- Kandidat duplicate dihapus.
- Preview clip tersedia.
- Basic crop berjalan.
- Subtitle berhasil dibuat.
- Final clip berhasil dirender.
- Quality check berjalan.
- User dapat preview dan download.
- Progress, retry, dan cancel berfungsi.

---

# Phase 3 — Advanced Clipping

## Tujuan

Meningkatkan kualitas visual, kontrol editing, intelligence, dan fleksibilitas hasil auto clipping setelah pipeline MVP sudah stabil.

Phase 3 tidak mengulang pipeline Phase 2 dari awal. Fitur lanjutan dibangun sebagai activity, adapter, dan output version baru agar stage sebelumnya dapat digunakan kembali.

---

## 1. Active Speaker Tracking

Development:

- Menentukan speaker aktif berdasarkan audio dan visual.
- Menghubungkan diarization dengan wajah.
- Memindahkan crop ke speaker yang sedang berbicara.
- Menahan crop agar tidak berpindah terlalu cepat.
- Menambahkan minimum active duration.
- Menggunakan confidence threshold.
- Fallback ke face tracking atau center crop.

Input:

- Speaker diarization.
- Face track.
- Audio activity.
- Scene metadata.

Output:

- Speaker timeline.
- Crop focal timeline.
- Confidence.
- Fallback reason.

---

## 2. Multi-Face Tracking

Development:

- Mendeteksi beberapa wajah.
- Memberi track ID.
- Mempertahankan identity antarframe.
- Memilih wajah utama.
- Menangani wajah yang keluar dan masuk frame.
- Mengurangi crop jumping.
- Menentukan framing saat dua orang aktif.

---

## 3. Split-Screen Dua Pembicara

Layout:

- Top-bottom.
- Left-right.
- Dynamic speaker emphasis.
- Equal split.
- Primary-secondary speaker.

Fitur:

- Face crop per speaker.
- Safe subtitle area.
- Automatic layout fallback.
- Scene-aware layout switching.
- Minimum layout duration.
- Smooth transition.

---

## 4. Speaker dan Screen-Share Layout

Untuk podcast, webinar, tutorial, atau presentasi:

- Speaker di bagian atas/bawah.
- Screen share sebagai area utama.
- Picture-in-picture.
- Dynamic resize.
- Screen content detection.
- Safe area per platform.
- Subtitle tidak menutupi konten penting.

---

## 5. Advanced Auto Reframing

Development:

- Face priority.
- Speaker priority.
- Object priority.
- Manual focal point.
- Scene-aware reframing.
- Tracking smoothing.
- Dead zone.
- Maximum movement speed.
- Zoom intensity.
- Motion anticipation.
- Crop stabilization.

Tujuannya agar hasil vertikal tidak terlihat bergoyang atau terlambat mengikuti subjek.

---

## 6. Clip Editor Ringan

Fitur editor:

- Trim start.
- Trim end.
- Preview source context.
- Manual crop focal point.
- Crop keyframe sederhana.
- Ganti aspect ratio.
- Ganti subtitle preset.
- Edit title.
- Edit caption.
- Edit CTA.
- Edit hashtag.
- Ganti thumbnail frame.
- Toggle watermark.
- Regenerate output.

Editor bukan full video editor seperti Adobe Premiere. Fokusnya pada koreksi cepat terhadap hasil AI.

---

## 7. Regenerate Per Clip

User dapat memilih:

- Regenerate metadata saja.
- Regenerate subtitle saja.
- Regenerate visual crop saja.
- Regenerate render saja.
- Regenerate kandidat clip.
- Regenerate seluruh clip.

Stage dependency digunakan agar sistem tidak mengulang transcription jika tidak diperlukan.

Contoh:

```text
Ganti subtitle preset
  ↓
GENERATING_SUBTITLES
  ↓
RENDERING_FINAL_CLIPS
  ↓
QUALITY_CHECK
```

Transcription, scene detection, dan AI analysis tidak perlu diulang.

---

## 8. Output Versioning

Setiap regenerate menghasilkan version baru:

```text
outputs/clips/{clip_id}/versions/1/final.mp4
outputs/clips/{clip_id}/versions/2/final.mp4
outputs/clips/{clip_id}/versions/3/final.mp4
```

Database menyimpan:

- Version.
- Parent version.
- Change reason.
- Render settings.
- Created by.
- Created at.
- Active version.
- Previous quality status.

Output lama tidak langsung ditimpa.

---

## 9. Brand Kit

Fitur:

- Logo.
- Watermark.
- Font.
- Primary color.
- Secondary color.
- Subtitle style.
- Intro.
- Outro.
- Safe margin.
- Thumbnail style.
- Default aspect ratio.

Brand kit dapat diterapkan ke:

- Satu clip.
- Satu job.
- Satu project.
- Default user preset.

---

## 10. Advanced Subtitle

Fitur lanjutan:

- Karaoke word highlight.
- Per-word animation.
- Phrase emphasis.
- Speaker labels.
- Emoji insertion level.
- Highlight color per keyword.
- Subtitle template.
- Dynamic placement.
- Face-aware subtitle positioning.
- Screen-content-aware positioning.
- Better ASS rendering.
- Translation review.
- Profanity bleep dan censor synchronization.

---

## 11. Advanced Quality Scoring

Menambahkan quality dimensions:

- Hook clarity.
- Context completeness.
- Ending strength.
- Audio clarity.
- Visual stability.
- Face visibility.
- Subtitle readability.
- Crop accuracy.
- Platform safe area.
- Render integrity.

Contoh output:

```json
{
  "content_score": 8.7,
  "visual_score": 8.2,
  "audio_score": 9.0,
  "subtitle_score": 8.5,
  "technical_score": 9.4,
  "overall_quality_score": 8.7
}
```

Quality score tidak menggantikan viral score.

- Viral score menilai potensi performa konten.
- Quality score menilai kualitas produksi dan teknis.

---

## 12. Thumbnail Selection

Development:

- Memilih frame dengan wajah jelas.
- Menghindari blur.
- Menghindari mata tertutup.
- Menghindari frame transisi.
- Menghindari subtitle terpotong.
- Menggunakan expression score.
- Menambahkan thumbnail text.
- Menyediakan beberapa pilihan.

---

## 13. Better Candidate Analysis

Peningkatan analyzer:

- Topic diversity.
- Speaker diversity.
- Narrative arc.
- Emotional progression.
- Debate structure.
- Question-answer pairing.
- Stronger ending detection.
- Misinformation/context risk.
- Cross-segment context reconstruction.
- Creator-specific learning dari feedback.

Feedback user dapat disimpan:

```text
Accepted
Rejected
Trimmed
Regenerated
Published
Archived
```

Data ini dapat digunakan untuk evaluasi prompt dan ranking, bukan langsung melatih model tanpa persetujuan dan governance.

---

## 14. Manual Review Workflow

Clip dapat ditandai:

```text
DRAFT
READY_FOR_REVIEW
APPROVED
REJECTED
NEEDS_CHANGES
READY_TO_PUBLISH
```

Fitur:

- Reviewer notes.
- Approval.
- Rejection reason.
- Requested changes.
- Audit history.
- Output version comparison.

Foundation ini juga mempersiapkan team workspace pada fase berikutnya.

---

## 15. Preset Lanjutan

Preset berdasarkan:

- TikTok.
- Instagram Reels.
- Facebook Reels.
- YouTube Shorts.
- Podcast.
- Interview.
- Webinar.
- Tutorial.
- Storytelling.
- Education.
- Debate.
- Product content.

Preset mencakup:

- Duration.
- Aspect ratio.
- Crop strategy.
- Subtitle style.
- Brand kit.
- Hook preference.
- CTA.
- Quality threshold.

---

## 16. Performance Optimization

Development:

- Parallel clip rendering.
- CPU worker pool.
- Optional GPU worker.
- Reuse transcript.
- Reuse face tracks.
- Reuse scene metadata.
- Reuse extracted audio.
- Cache model result.
- Render concurrency limit.
- Resource-aware scheduling.
- Temporary storage quota.
- Automatic cleanup.
- Workflow checkpoint.

---

## 17. Advanced Admin Monitoring

Admin dapat melihat:

- Render duration.
- Reframe duration.
- Tracking confidence.
- GPU usage.
- CPU usage.
- Clip failure category.
- Quality score distribution.
- Average viral score.
- Regenerate rate.
- User acceptance rate.
- Provider latency.
- Cost per job.
- Cost per clip.

---

## Deliverable Phase 3

Phase 3 selesai jika:

- Active speaker tracking berjalan.
- Multi-face tracking tersedia.
- Split-screen dapat digunakan.
- Speaker dan screen-share layout tersedia.
- Auto reframing lebih stabil.
- User dapat mengedit trim dan crop.
- User dapat mengganti subtitle preset.
- Regenerate per clip dan per stage berjalan.
- Output versioning berjalan.
- Brand kit dapat diterapkan.
- Advanced subtitle tersedia.
- Quality score tersedia.
- Thumbnail selection tersedia.
- Stage sebelumnya dapat digunakan kembali tanpa selalu mengulang workflow.

---

# Acceptance Criteria Gabungan Phase 1–3

Project dianggap memenuhi Phase 1 sampai Phase 3 jika:

1. User dapat register, login, logout, verifikasi email, dan reset password.
2. Google OAuth tersedia.
3. Superadmin mempunyai dashboard dan user management.
4. RBAC dan permission berjalan.
5. View-as-user memiliki reason dan audit trail.
6. User dapat upload video besar langsung ke MinIO.
7. Media metadata disimpan di PostgreSQL.
8. User dapat membuat auto clipping job.
9. Temporal menjalankan workflow yang tahan restart.
10. Progress job tampil real-time.
11. Job dapat dicancel dan diretry.
12. Python menghasilkan transcript bertimestamp.
13. Scene dan silence detection tersedia.
14. AI menghasilkan kandidat clip JSON tervalidasi.
15. Boundary kandidat dinormalisasi.
16. Kandidat duplicate dihapus.
17. Preview clip tersedia.
18. Basic dan advanced crop tersedia.
19. Subtitle dapat dibuat dan dibakar ke video.
20. Final video dapat dirender.
21. Quality check berjalan.
22. Active speaker tracking tersedia.
23. Split-screen tersedia.
24. User dapat mengedit trim dan crop.
25. User dapat regenerate clip tanpa selalu mengulang seluruh pipeline.
26. Output memiliki versioning.
27. Brand kit tersedia.
28. User dapat preview dan download output.
29. Secret terenkripsi dan tidak muncul di log.
30. Dokumentasi maintenance dan testing tersedia.

---

# Catatan Scope

## Selesai pada Phase 1

- Fondasi aplikasi.
- Authentication.
- Authorization.
- Upload.
- Database.
- Job framework.
- Temporal foundation.
- Progress.
- Observability dasar.

## Selesai pada Phase 2

- Auto clipping MVP end-to-end.
- Transcription.
- Scene dan silence analysis.
- AI candidate analyzer.
- Basic crop.
- Subtitle.
- Rendering.
- Quality check.
- Preview dan download.

## Selesai pada Phase 3

- Advanced reframing.
- Active speaker.
- Multi-face.
- Split-screen.
- Clip editor ringan.
- Regenerate per stage.
- Versioning.
- Brand kit.
- Advanced subtitle.
- Advanced quality scoring.

## Belum termasuk sampai Phase 3

- Text to Speech tool lengkap.
- Transcript editor lengkap.
- Social publishing production.
- Subscription payment.
- Billing provider.
- Team workspace lengkap.
- Content analytics dari social platform.
- Mobile application.
- Full-scale Kubernetes production rollout.

Fitur tersebut dapat dilanjutkan pada Phase 4 dan Phase 5.
