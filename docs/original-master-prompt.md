# MASTER PROMPT — CONTENT CREATOR AI PLATFORM

## Peran Anda

Bertindaklah sebagai gabungan dari:

1. Principal Software Architect.
2. Senior Backend Engineer Node.js/TypeScript.
3. Senior Python Engineer untuk AI dan video processing.
4. Senior DevOps/SRE Engineer.
5. Senior Product Designer UI/UX.
6. Senior Prompt Engineer.
7. Content strategist dan video clipper profesional yang memahami retention, hook, emosi, konflik, dan potensi viral konten short-form.

Anda harus merancang dan mengimplementasikan sebuah platform web profesional untuk content creator. Platform harus aman, mudah digunakan, scalable, observable, tahan terhadap kegagalan proses panjang, dan mudah dipelihara oleh engineer maupun AI pada masa depan.

Jangan hanya membuat mockup. Buat rancangan yang siap diimplementasikan dan kemudian hasilkan source code secara bertahap dengan struktur production-grade.

---

# 1. Tujuan Produk

Bangun platform web bernama sementara **Creator Studio AI** yang membantu content creator untuk:

1. Mengubah video panjang menjadi beberapa short clip yang berpotensi memiliki retention dan engagement tinggi.
2. Membuat audio natural dari naskah.
3. Membuat transkrip dan subtitle dari video/audio.
4. Meninjau, mengedit, mengunduh, dan memublikasikan hasil konten.
5. Melihat seluruh proses pekerjaan melalui job dashboard, progress, log, hasil, dan riwayat.
6. Menggunakan kredensial AI milik sendiri atau kredensial yang disediakan platform.

Platform memiliki dua role utama:

- `USER`
- `SUPERADMIN`

Superadmin dapat membuka mode tampilan user tanpa kehilangan akses admin. Gunakan mekanisme **impersonation/audit-safe view-as-user**, bukan mengganti session secara tidak terlacak.

---

# 2. Prinsip Arsitektur Wajib

1. Gunakan pendekatan modular monolith untuk aplikasi Node.js pada tahap awal, tetapi batas antarmodul harus jelas agar mudah dipecah menjadi microservice jika skala meningkat.
2. Pisahkan aplikasi web/orchestrator Node.js dengan worker Python untuk seluruh proses berat.
3. Node.js tidak boleh menjalankan AI inference, transcription, computer vision, atau FFmpeg.
4. Python tidak boleh menangani autentikasi web, session browser, billing utama, dan rendering halaman EJS.
5. Jangan mengirim file video besar antarlayanan melalui request REST biasa.
6. Semua file media disimpan di MinIO. Antarlayanan hanya mengirim `object_key`, metadata, dan signed URL jika dibutuhkan.
7. Upload file browser menggunakan multipart upload atau presigned URL langsung ke MinIO.
8. Workflow panjang auto clipping menggunakan Temporal agar dapat melanjutkan proses setelah crash, timeout, atau restart.
9. BullMQ hanya digunakan untuk pekerjaan ringan atau pendek, misalnya email, webhook, sinkronisasi metadata, notifikasi, dan publish status polling.
10. Setiap job harus idempotent, dapat di-retry per tahap, dapat dibatalkan, dan memiliki audit trail.
11. Gunakan REST API untuk command/control antarlayanan. Gunakan Temporal untuk workflow orchestration dan MinIO untuk pertukaran media.
12. Gunakan WebSocket atau Server-Sent Events untuk progress real-time. Sediakan fallback polling.
13. Semua fitur provider AI harus menggunakan abstraction layer. Jangan hardcode OpenAI ke business logic.
14. Semua secret harus dienkripsi saat tersimpan dan tidak boleh muncul di log.
15. Gunakan clean architecture/pragmatic layered architecture. Hindari overengineering.

---

# 3. Technology Stack

## Aplikasi Web dan Orchestrator

- Node.js LTS
- TypeScript strict mode
- Express.js
- EJS sebagai template engine
- Bootstrap 5
- Vanilla JavaScript modular
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ
- Temporal TypeScript SDK
- Passport atau library autentikasi yang sesuai
- WebSocket atau SSE
- Zod untuk validation
- Pino untuk structured logging

## AI dan Media Worker

- Python versi stabil modern
- FastAPI untuk internal REST API
- Pydantic
- Temporal Python SDK
- faster-whisper untuk speech-to-text
- FFmpeg/FFprobe
- PySceneDetect
- OpenCV
- MediaPipe dan/atau YOLO melalui adapter
- webrtcvad atau FFmpeg silencedetect
- Provider SDK melalui adapter: OpenAI, Gemini, Claude, dan provider lain di masa depan

## Infrastruktur

- PostgreSQL
- Redis
- MinIO
- Temporal Server
- Docker Compose untuk development
- Kubernetes untuk production
- Prometheus
- Grafana
- Loki + Promtail, atau OpenTelemetry Collector + backend log yang dipilih
- OpenTelemetry untuk tracing
- Nginx atau ingress controller

---

# 4. Struktur Repository

Gunakan monorepo dengan struktur awal berikut. Nama dapat disempurnakan selama tanggung jawabnya tetap jelas.

```text
creator-studio-ai/
├── apps/
│   ├── web-node/
│   │   ├── src/
│   │   │   ├── bootstrap/
│   │   │   ├── config/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── users/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── jobs/
│   │   │   │   ├── auto-clipping/
│   │   │   │   ├── text-to-speech/
│   │   │   │   ├── transcription/
│   │   │   │   ├── media-library/
│   │   │   │   ├── publishing/
│   │   │   │   ├── ai-providers/
│   │   │   │   ├── billing/
│   │   │   │   ├── notifications/
│   │   │   │   ├── admin/
│   │   │   │   └── audit/
│   │   │   ├── shared/
│   │   │   ├── views/
│   │   │   ├── public/
│   │   │   └── server.ts
│   │   ├── prisma/
│   │   └── tests/
│   ├── media-ingestion-node/
│   │   ├── src/
│   │   └── tests/
│   └── ai-media-python/
│       ├── app/
│       │   ├── api/
│       │   ├── application/
│       │   ├── domain/
│       │   ├── infrastructure/
│       │   ├── workflows/
│       │   ├── activities/
│       │   ├── providers/
│       │   ├── media/
│       │   └── main.py
│       └── tests/
├── packages/
│   ├── contracts/
│   ├── config/
│   └── observability/
├── infra/
│   ├── docker/
│   ├── kubernetes/
│   ├── monitoring/
│   └── scripts/
├── docs/
│   ├── architecture.md
│   ├── workflows.md
│   ├── database.md
│   ├── api.md
│   ├── security.md
│   ├── operations.md
│   ├── troubleshooting.md
│   ├── ai-maintenance-guide.md
│   └── adr/
├── .env.example
├── docker-compose.yml
├── Makefile
└── README.md
```

`media-ingestion-node` bertugas khusus mengambil sumber eksternal yang diizinkan, memvalidasi metadata, mengunduh media, menghitung checksum, lalu menyimpan media ke MinIO. Jangan menyimpan media sementara lebih lama dari yang diperlukan.

Pastikan penggunaan sumber eksternal mematuhi hak cipta, persyaratan layanan platform, dan hak pengguna atas konten.

---

# 5. Authentication, Authorization, dan Security

Implementasikan:

1. Login email dan password.
2. Login Google OAuth.
3. Forgot password dengan token satu kali, expiry pendek, dan invalidasi setelah digunakan.
4. Verifikasi email.
5. Opsional 2FA/TOTP untuk user dan wajib tersedia untuk superadmin.
6. Role-based access control.
7. Permission-based guard untuk fungsi sensitif.
8. Session aman menggunakan HTTP-only, Secure, SameSite cookie.
9. Session rotation setelah login dan privilege change.
10. CSRF protection untuk form.
11. Rate limiting global, per-user, per-IP, dan endpoint sensitif.
12. Password hashing Argon2id atau algoritma modern yang setara.
13. Account lockout/backoff untuk brute force.
14. Device/session management: lihat dan cabut session aktif.
15. Audit log untuk login, perubahan role, perubahan credentials, retry job, cancel job, impersonation, dan aksi admin.
16. Encryption at rest untuk API key user/admin menggunakan envelope encryption atau master key dari secret manager.
17. Secret masking pada UI dan log.
18. Validasi MIME type, extension, ukuran, checksum, dan FFprobe untuk upload media.
19. Antivirus/malware scanning hook untuk file upload.
20. Content Security Policy, Helmet, HSTS, X-Frame-Options, dan header keamanan lain.
21. Sanitasi output EJS dan hindari penggunaan raw HTML tanpa kebutuhan.
22. Signed URL MinIO dengan expiry singkat.
23. Network policy Kubernetes: service internal tidak boleh terbuka ke internet.
24. API internal menggunakan service authentication, misalnya mTLS atau signed service token.
25. Semua aksi destructive menggunakan confirmation dan audit log.

Redirect setelah login:

- User diarahkan ke `/app/dashboard`.
- Superadmin diarahkan ke `/admin/dashboard`.
- Superadmin dapat memilih `Open User Workspace` untuk membuka `/app/dashboard` dengan role tetap dan audit context tetap aktif.

---

# 6. Halaman dan Navigasi User

Gunakan sidebar profesional, responsive, tidak membingungkan, dan dapat collapse.

Menu utama:

1. Dashboard
2. Tools
   - Auto Clipping
   - Text to Speech
   - Transcription & Subtitle
3. Jobs
4. Media Library
5. Publishing
6. Templates/Presets
7. Usage & Billing
8. Notifications
9. Settings
10. Help & Documentation

## Dashboard User

Tampilkan:

- Welcome header dan quick action.
- Ringkasan jumlah job hari ini/bulan ini.
- Job running, queued, completed, failed, dan canceled.
- Total source duration yang diproses.
- Jumlah clip yang dihasilkan.
- Rata-rata viral score.
- Estimasi pemakaian AI, transcription minute, rendering minute, dan storage.
- Grafik job per hari.
- Grafik status job.
- Grafik clip berdasarkan score range.
- Recent projects.
- Recent outputs.
- Notifikasi error atau quota mendekati batas.
- Tombol cepat: New Auto Clip, New Voice, New Transcription.

Tabel job terbaru:

- Job ID pendek dan link detail.
- Tool.
- Nama project.
- Source.
- Status.
- Current stage.
- Progress percentage.
- Created at.
- Duration running.
- Estimated remaining time hanya jika datanya cukup; jangan tampilkan estimasi palsu.
- Actions: view, cancel, retry failed stage, duplicate, delete sesuai status.

## Halaman Jobs

Sediakan filter:

- Tool type.
- Status.
- Date range.
- Search job ID/project.
- Provider.
- Created by.

Detail job harus memiliki:

- Progress stepper.
- Status real-time.
- Timeline tiap tahap.
- Structured user-friendly log.
- Error summary.
- Technical error ID, bukan stack trace mentah.
- Input snapshot.
- Output list.
- Cost/usage summary.
- Tombol cancel.
- Tombol retry dari tahap gagal.
- Tombol regenerate/duplicate dengan input sebelumnya.
- Tombol download seluruh hasil sebagai ZIP.

## Media Library

Tampilkan source video, audio, transcript, subtitle, thumbnail, waveform, dan clip final.

Fitur:

- Grid/list view.
- Search dan filter.
- Tag/folder/project.
- Preview.
- Download.
- Rename metadata.
- Soft delete dan restore.
- Storage usage.
- Retention policy.

---

# 7. Settings User

Buat submenu:

## Profile

- Nama.
- Avatar.
- Bahasa: Indonesia/English.
- Timezone.
- Default content niche.
- Default audience.

## AI Provider

User dapat memilih:

- `Use platform credentials`.
- `Use my own credentials`.

Field:

- Provider.
- API key terenkripsi.
- Base URL opsional untuk provider kompatibel.
- Organization/project ID opsional.
- Model untuk clip analysis.
- Model untuk text generation.
- Model untuk TTS bila provider mendukung.
- Test connection.
- Last connection status.
- Masked secret.

Daftar model jangan ditulis statis di view. Model berasal dari tabel konfigurasi admin/provider capability dan dapat disinkronkan melalui adapter jika provider mendukung endpoint daftar model.

## Default Clipping Preset

- Target platform.
- Aspect ratio.
- Duration range.
- Subtitle style.
- Crop strategy.
- Language.
- Number of clips.
- Minimum viral score.
- Brand preset.

## Brand Kit

- Logo/watermark.
- Font.
- Warna brand.
- Intro/outro opsional.
- Safe margin.
- Subtitle preset.

## Social Connections

- Facebook/Instagram connection.
- TikTok connection.
- OAuth token status.
- Expiry.
- Reconnect/revoke.

## Notification Preferences

- Job completed.
- Job failed.
- Publish completed/failed.
- Quota warning.
- Email/in-app/webhook.

## Security

- Change password.
- 2FA.
- Active sessions.
- Login history.
- Revoke session.

---

# 8. Tool Unggulan — Auto Clipping

## A. UX Flow

Gunakan wizard maksimal 4 langkah:

1. Source
2. Content Strategy
3. Visual & Subtitle
4. Review & Submit

Sediakan mode:

- `Quick Mode`: hanya input penting.
- `Advanced Mode`: seluruh kontrol detail.

Simpan draft otomatis. Sediakan preset agar user tidak perlu mengisi semuanya berulang kali.

## B. Input Source

User memilih salah satu:

- Upload video.
- URL YouTube atau sumber lain yang secara hukum dan teknis didukung.
- Pilih video dari Media Library.

Field source:

- Project name.
- Source URL atau file.
- Source language: auto detect/manual.
- Speaker count: auto/manual.
- Content title.
- Description/context opsional.
- Topic utama.
- Kata/nama khusus untuk transcription vocabulary.
- Hak penggunaan konten checkbox.

Untuk upload besar:

- Browser upload langsung ke MinIO menggunakan multipart presigned upload.
- Node.js hanya membuat upload session dan memverifikasi completion.

Untuk URL:

- Node API membuat ingestion job.
- `media-ingestion-node` mengunduh media dan mengunggahnya ke MinIO.
- Python tidak mengunduh dari internet.

## C. Content Strategy Input

Field wajib/opsional:

- Niche.
- Target audience.
- Target platform: TikTok, Instagram Reels, Facebook Reels, YouTube Shorts, atau custom.
- Objective: engagement, education, controversy, storytelling, product awareness, lead generation.
- Tone: serious, educational, funny, dramatic, inspiring, casual, controversial.
- Preferred topics.
- Topics to avoid.
- Sensitive words/topics.
- Desired number of clips.
- Minimum and maximum clip duration.
- Minimum viral score.
- Hook style.
- CTA preference.
- Clip language.
- Include/exclude speaker.
- Allow context reconstruction from kalimat sekitar.
- Remove filler words.
- Remove long silence.
- Profanity handling: keep, mute, bleep, subtitle censor.
- Duplicate/overlap tolerance antarclip.

Durasi preset:

- 15–30 seconds.
- 30–45 seconds.
- 45–60 seconds.
- 60–90 seconds.
- Custom.

## D. Visual dan Crop Options

Aspect ratio:

- 9:16
- 1:1
- 4:5
- 16:9
- Custom

Crop strategy:

1. Center crop.
2. Active speaker tracking.
3. Face tracking.
4. Auto reframing.
5. Split screen dua pembicara.
6. Speaker + screen/share layout.
7. Original ratio dengan blurred background.
8. Manual crop focal point.

Advanced visual settings:

- Safe area per platform.
- Zoom intensity.
- Tracking smoothing.
- Scene-cut-aware reframing.
- Face priority.
- Multi-face selection.
- Background blur.
- Watermark/logo.
- Intro/outro.
- Color correction preset opsional.
- Thumbnail frame selection.

## E. Subtitle Options

- Subtitle on/off.
- Language.
- Translation target opsional.
- Burn-in subtitle atau sidecar file.
- Export SRT, VTT, ASS, dan JSON timestamp.
- Style preset.
- Font.
- Font size.
- Text color.
- Highlight color per kata.
- Background box.
- Stroke/shadow.
- Position.
- Max words per line.
- Max lines.
- Karaoke word highlight.
- Emoji insertion: off/low/medium.
- Speaker labels.
- Profanity censor.
- Safe margin.
- Preview style sebelum submit.

Jangan membuat subtitle terlalu ramai. Gunakan line breaking berdasarkan frasa, bukan jumlah karakter saja.

## F. Workflow Auto Clipping

Gunakan Temporal workflow dengan tahap berikut:

1. `VALIDATING_SOURCE`
2. `INGESTING_SOURCE`
3. `PROBING_MEDIA`
4. `EXTRACTING_AUDIO`
5. `TRANSCRIBING`
6. `DIARIZING_OR_SPEAKER_ANALYSIS`
7. `DETECTING_SCENES`
8. `DETECTING_SILENCE`
9. `ANALYZING_CLIP_CANDIDATES`
10. `NORMALIZING_BOUNDARIES`
11. `RANKING_AND_DEDUPLICATING`
12. `GENERATING_PREVIEWS`
13. `REFRAMING`
14. `GENERATING_SUBTITLES`
15. `RENDERING_FINAL_CLIPS`
16. `QUALITY_CHECK`
17. `GENERATING_METADATA`
18. `UPLOADING_OUTPUTS`
19. `COMPLETED`

Setiap activity harus:

- Memiliki timeout.
- Retry policy.
- Heartbeat untuk proses lama.
- Idempotency key.
- Structured progress event.
- Cancellation handling.
- Error classification: retryable/non-retryable.
- Cleanup temporary file.

Simpan checkpoint agar retry tidak selalu mengulang dari awal.

## G. Transcription

Gunakan faster-whisper.

Output minimum:

- Segment timestamp.
- Word timestamp jika tersedia.
- Detected language.
- Confidence.
- Speaker label jika diarization aktif.
- Normalized text.
- Raw text.

Dukung custom vocabulary untuk nama orang, brand, istilah teknis, dan singkatan.

## H. AI Clip Analyzer

LLM hanya menerima transcript bertimestamp, metadata scene/silence/speaker, konteks user, dan aturan analisis. LLM tidak merender video.

Jangan sekadar mencari keyword. Analisis struktur momen, konteks, emosi, konflik, novelty, payoff, dan kemungkinan retention.

### Tujuan Seleksi

Pilih bagian yang paling mungkin membuat penonton:

- Berhenti scroll.
- Bertahan hingga akhir.
- Menonton ulang.
- Mengirim kepada orang lain.
- Menulis komentar.
- Membantah atau berdiskusi.

### Syarat Hook

Awal clip harus cepat dipahami dan memiliki salah satu pola:

- Pernyataan mengejutkan.
- Klaim kontra-intuitif.
- Pengakuan pribadi.
- Pertanyaan kuat.
- Konflik yang langsung terlihat.
- Janji insight yang jelas.
- Momen reaksi emosional.

Hindari clip yang membutuhkan konteks panjang sebelum menarik.

### Sinyal Positif

Prioritaskan:

- Kontroversi yang memiliki konteks jelas.
- Perdebatan atau bantahan.
- Opini tegas.
- Sudut pandang tidak umum.
- Fakta mengejutkan.
- Cerita pengalaman langsung.
- Pengakuan pribadi.
- Kritik sosial.
- Teori atau kerangka berpikir baru.
- Fakta yang bertentangan dengan asumsi umum.
- Momen host/tamu kaget.
- Tawa spontan yang tetap dapat dipahami.
- Punchline.
- Transformasi emosi.
- Jawaban konkret terhadap pertanyaan menarik.

### Sinyal Negatif

Jangan pilih:

- Opening podcast.
- Sapaan.
- Basa-basi.
- Sponsor/promosi yang tidak diminta.
- Perkenalan tamu.
- Transisi topik.
- Pengulangan.
- Kalimat tanpa payoff.
- Bagian dengan referensi “ini/itu/dia” yang tidak dapat dipahami tanpa konteks.
- Clip terpotong di tengah argumen.
- Clip yang berakhir sebelum kesimpulan.
- Momen viral semu yang menyesatkan karena menghilangkan konteks penting.

### Viral Score

Gunakan skor komponen 0–10:

- `hook_score`: 30%
- `conflict_score`: 25%
- `emotion_score`: 20%
- `novelty_score`: 15%
- `comment_potential_score`: 10%

Rumus dasar:

```text
viral_score =
  hook_score * 0.30 +
  conflict_score * 0.25 +
  emotion_score * 0.20 +
  novelty_score * 0.15 +
  comment_potential_score * 0.10
```

Tambahkan quality gates dan penalty, tanpa mengubah transparansi skor dasar:

- `context_penalty`: 0–2.0
- `weak_ending_penalty`: 0–1.0
- `slow_start_penalty`: 0–1.0
- `duplicate_penalty`: 0–1.5
- `unsafe_or_misleading_penalty`: 0–3.0
- `cut_quality_penalty`: 0–1.0

```text
final_viral_score = clamp(
  viral_score - total_penalty,
  0,
  10
)
```

Interpretasi:

- 9.0–10.0: sangat berpotensi viral.
- 8.0–8.9: sangat layak diposting.
- 7.0–7.9: layak diposting.
- Di bawah 7.0: jangan dipilih kecuali user mengizinkan fallback.

Jika dua kandidat memiliki nilai informasi serupa, prioritaskan kandidat dengan emosi, konflik, hook, dan akhir yang lebih kuat.

### Boundary Rules

- Awal clip harus dimulai pada batas kalimat/frasa yang wajar.
- Tambahkan pre-roll pendek hanya bila dibutuhkan agar kalimat tidak terasa terpotong.
- Akhir clip harus memiliki payoff, kesimpulan, punchline, atau pertanyaan yang memancing komentar.
- Gunakan scene detection agar pemotongan tidak janggal.
- Hindari memotong kata atau napas secara kasar.
- Batasi overlap antarclip, kecuali user mengaktifkannya.

### Output JSON Analyzer

LLM wajib mengembalikan JSON tervalidasi seperti berikut:

```json
{
  "analysis_version": "1.0",
  "source_summary": "string",
  "candidates": [
    {
      "candidate_id": "string",
      "start_seconds": 120.4,
      "end_seconds": 168.2,
      "duration_seconds": 47.8,
      "title": "string",
      "hook_text": "string",
      "ending_text": "string",
      "summary": "string",
      "why_it_works": ["string"],
      "content_category": "debate|insight|story|reaction|humor|other",
      "scores": {
        "hook": 9.2,
        "conflict": 8.5,
        "emotion": 8.1,
        "novelty": 8.8,
        "comment_potential": 9.0,
        "base_viral_score": 8.75,
        "penalties": {
          "context": 0.0,
          "weak_ending": 0.0,
          "slow_start": 0.0,
          "duplicate": 0.0,
          "unsafe_or_misleading": 0.0,
          "cut_quality": 0.0
        },
        "final_viral_score": 8.75
      },
      "context_complete": true,
      "safety_notes": [],
      "suggested_caption": "string",
      "suggested_cta": "string",
      "suggested_hashtags": ["string"],
      "thumbnail_text": "string",
      "speaker_ids": ["SPEAKER_01"],
      "scene_ids": ["scene-10", "scene-11"]
    }
  ]
}
```

Gunakan schema validation dan lakukan repair/retry jika respons provider tidak valid. Simpan prompt version, provider, model, token usage, latency, dan response ID untuk audit dan evaluasi.

## I. Ranking, Deduplication, dan Quality Check

Setelah hasil LLM:

1. Validasi timestamp berada di dalam source duration.
2. Normalisasi boundary berdasarkan word timestamp, silence, dan scene.
3. Hapus kandidat duplicate/near-duplicate menggunakan transcript similarity dan overlap timestamp.
4. Verifikasi durasi sesuai input.
5. Pastikan hook muncul dalam beberapa detik pertama.
6. Pastikan ending tidak menggantung tanpa alasan kreatif.
7. Jalankan black-frame, frozen-frame, audio loudness, subtitle overflow, dan output integrity check.
8. Tandai clip sebagai `NEEDS_REVIEW` jika quality gate gagal.

## J. Hasil Auto Clipping

Halaman hasil menampilkan:

- Video preview.
- Viral score.
- Breakdown score.
- Hook text.
- Alasan dipilih.
- Timestamp source.
- Transcript clip.
- Suggested title.
- Caption.
- CTA.
- Hashtag.
- Thumbnail suggestion.
- Quality status.
- Render settings.

Actions per clip:

- Preview.
- Edit metadata.
- Trim start/end sederhana.
- Pilih crop focal point.
- Ganti subtitle preset.
- Regenerate satu clip.
- Download video.
- Download subtitle.
- Download caption metadata.
- Publish ke platform terhubung.
- Archive/delete.

Actions pada job:

- Retry failed stage.
- Regenerate seluruh kandidat dengan input yang dapat diubah.
- Duplicate as new job.
- Download all ZIP.

---

# 9. Text to Speech Tool

## Form Input

- Project name.
- Script text.
- Upload TXT/MD/DOCX opsional jika didukung.
- Language.
- Voice provider.
- Voice/model.
- Gender/voice character metadata bila provider mendukung.
- Speaking style: documentary, conversational, warm, serious, energetic, news, storytelling.
- Emotion.
- Speaking speed.
- Pitch.
- Pause intensity.
- Pronunciation dictionary.
- Target duration.
- Output format: MP3/WAV.
- Sample rate/bitrate.
- Normalize loudness.
- Background music opsional dengan ducking.

## Target Duration

Jika user mengisi target duration:

1. Hitung estimasi durasi dari word count dan speaking rate.
2. Tampilkan apakah naskah terlalu pendek/panjang.
3. Sediakan action `Adjust script to duration`.
4. Jangan mengubah makna inti tanpa persetujuan user.
5. Tampilkan versi sebelum dan sesudah.

## Custom Voice

Custom voice hanya boleh digunakan jika provider mendukung dan user menyatakan memiliki hak/izin atas suara tersebut. Tambahkan consent record, audit trail, dan larangan impersonasi tanpa izin.

## Hasil

- Audio player.
- Waveform.
- Duration.
- Script.
- Provider/model.
- Download.
- Regenerate.
- Duplicate settings.
- Save voice preset.

Gunakan background job untuk naskah panjang.

---

# 10. Transcription & Subtitle Tool

## Input

- Upload audio/video atau pilih Media Library.
- Language auto/manual.
- Model preset.
- Word-level timestamp.
- Speaker diarization.
- Number of speakers opsional.
- Custom vocabulary.
- Remove filler words.
- Profanity handling.
- Subtitle line length.
- Max lines.
- Subtitle style preview.
- Translate subtitle.
- Burn subtitle to video opsional.

## Output

- Transcript editor dengan timestamp.
- Search/replace.
- Speaker rename.
- Playback synced dengan transcript.
- Export TXT, JSON, SRT, VTT, ASS.
- Burned video preview.
- Confidence warning pada bagian yang kurang jelas.
- Regenerate selected segment.

---

# 11. Publishing Integration

Sediakan integrasi resmi melalui API/OAuth platform yang tersedia dan diizinkan.

Fitur:

- Connect/revoke account.
- Pilih destination account/page.
- Caption.
- Hashtag.
- Thumbnail.
- Schedule publish.
- Draft/publish now jika API mendukung.
- Status publish.
- Retry.
- Error reason yang mudah dipahami.
- Audit log.

Jangan menjanjikan dukungan upload jika API platform atau izin aplikasi belum tersedia. Implementasikan capability flag per platform.

Publishing berjalan sebagai background job. Token OAuth dienkripsi. Refresh token harus ditangani aman.

---

# 12. Halaman Superadmin

Menu admin:

1. Dashboard
2. Users
3. Roles & Permissions
4. Jobs & Workflows
5. AI Providers
6. Models & Capabilities
7. Platform Credentials
8. Tool Configuration
9. Pricing, Plans & Quotas
10. Usage & Costs
11. Storage
12. Social Integrations
13. Templates & Presets
14. Feature Flags
15. Notifications
16. Audit Logs
17. System Logs
18. Worker & Queue Health
19. System Settings

## Dashboard Admin

Tampilkan:

- Total users.
- Active users.
- New users.
- Running/queued/failed/completed jobs.
- Success rate.
- P50/P95 job duration per tool.
- AI provider latency/error rate.
- Token and estimated provider cost.
- Transcription minute.
- Render minute.
- Storage usage.
- Queue backlog.
- Temporal workflow health.
- Worker online/offline.
- CPU/GPU/memory summary dari monitoring.
- Top error categories.
- Top users by usage.
- Quota alerts.
- Provider credential health.

## CRUD Users

- Search/filter.
- Create/update/disable.
- Verify email.
- Reset password link.
- Assign role/plan/quota.
- View usage.
- View jobs.
- Revoke sessions.
- Suspend publishing.
- Soft delete.
- Audit history.
- View-as-user dengan reason wajib dan audit log.

## AI Provider dan Model

Relasi:

- Satu provider memiliki banyak model.
- Satu model memiliki capability: chat, structured output, TTS, STT, vision, embedding, dan lainnya.

Admin dapat:

- CRUD provider.
- CRUD model.
- Enable/disable.
- Set display name.
- Set model identifier.
- Set capability.
- Set context limit/limits sebagai metadata konfigurasi.
- Set default model per tool.
- Set fallback model chain.
- Set timeout/retry.
- Set price metadata.
- Test connection.
- Mark degraded.
- Configure rate limit.

## Platform Credentials

- Credentials per provider.
- Encryption.
- Rotation.
- Last tested.
- Health status.
- Usage limit.
- Allowed tools/models.
- Masked display.
- Audit change.

User yang memilih platform credentials menggunakan credential aktif sesuai routing policy admin.

## Jobs & Workflows

Admin dapat:

- Filter semua job.
- Lihat workflow dan stage.
- Pause/cancel/terminate dengan aturan aman.
- Retry failed stage.
- Restart sebagai job baru.
- Reassign priority.
- View input snapshot.
- View output.
- View error ID.
- View logs/traces.
- Cleanup orphan temporary files.

Jangan menyediakan tombol “start ulang” yang mengubah job completed secara ambigu. Gunakan aksi eksplisit:

- Retry current failed stage.
- Resume paused workflow.
- Duplicate as new job.

## Plans, Quotas, dan Billing

Walaupun pembayaran dapat menjadi fase lanjutan, desain data model untuk:

- Plan.
- Monthly quota.
- Max upload size.
- Max source duration.
- Clip count.
- Transcription minutes.
- TTS characters/minutes.
- Storage.
- Concurrent jobs.
- Provider credential mode.
- Retention days.

## System Settings

- Upload limits.
- Allowed MIME.
- Signed URL expiry.
- Default retention.
- Retry defaults.
- Provider routing.
- Maintenance mode.
- Registration on/off.
- Email configuration.
- Feature flags.
- Webhook configuration.
- Content moderation settings.

---

# 13. Job State Machine

Gunakan state berikut:

- `DRAFT`
- `UPLOADING`
- `QUEUED`
- `RUNNING`
- `PAUSE_REQUESTED`
- `PAUSED`
- `CANCEL_REQUESTED`
- `CANCELED`
- `FAILED`
- `COMPLETED`
- `PARTIALLY_COMPLETED`
- `NEEDS_REVIEW`

Simpan `current_stage` terpisah dari overall status.

Setiap progress event minimal berisi:

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

Overall progress menggunakan bobot stage yang dikonfigurasi, bukan angka acak.

---

# 14. Penyimpanan MinIO

Gunakan object key terorganisir:

```text
users/{user_id}/jobs/{job_id}/source/original.ext
users/{user_id}/jobs/{job_id}/working/audio.wav
users/{user_id}/jobs/{job_id}/working/transcript.json
users/{user_id}/jobs/{job_id}/working/scenes.json
users/{user_id}/jobs/{job_id}/working/candidates.json
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/preview.mp4
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/final.mp4
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/subtitle.srt
users/{user_id}/jobs/{job_id}/outputs/clips/{clip_id}/metadata.json
```

Database menyimpan metadata dan object key, bukan binary media.

Tambahkan:

- Checksum.
- MIME type.
- Size.
- Duration.
- Width/height.
- Status.
- Retention expiry.
- Soft-delete timestamp.

Gunakan lifecycle policy untuk temporary files.

---

# 15. Database Design

Buat Prisma schema dengan entitas minimum:

- User
- Role
- Permission
- UserRole
- Session
- OAuthAccount
- PasswordResetToken
- EmailVerificationToken
- UserSetting
- AiProvider
- AiModel
- AiModelCapability
- EncryptedCredential
- UserAiPreference
- Project
- MediaAsset
- UploadSession
- Job
- JobStage
- JobEvent
- JobAttempt
- JobError
- AutoClipRequest
- ClipCandidate
- ClipOutput
- Transcript
- TranscriptSegment
- SubtitleAsset
- TtsRequest
- TtsOutput
- TranscriptionRequest
- SocialConnection
- PublishJob
- PublishDestination
- Preset
- BrandKit
- UsageRecord
- Quota
- Plan
- Notification
- WebhookEndpoint
- AuditLog
- FeatureFlag
- SystemSetting

Gunakan UUID. Terapkan index untuk status, user_id, job_id, created_at, provider_id, dan field pencarian penting.

Gunakan soft delete pada data yang perlu dipulihkan. Jangan soft delete untuk semua tabel tanpa alasan.

Tambahkan optimistic locking/version field untuk entity yang rawan concurrent update.

---

# 16. API Design

Gunakan `/api/v1`.

Contoh endpoint:

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/forgot-password
POST   /api/v1/auth/reset-password
GET    /api/v1/auth/google
GET    /api/v1/auth/google/callback

POST   /api/v1/uploads
POST   /api/v1/uploads/:id/complete

POST   /api/v1/auto-clipping/jobs
GET    /api/v1/auto-clipping/jobs/:jobId
POST   /api/v1/auto-clipping/jobs/:jobId/cancel
POST   /api/v1/auto-clipping/jobs/:jobId/retry
POST   /api/v1/auto-clipping/jobs/:jobId/duplicate

GET    /api/v1/jobs
GET    /api/v1/jobs/:jobId/events
GET    /api/v1/jobs/:jobId/outputs

POST   /api/v1/tts/jobs
POST   /api/v1/transcription/jobs
POST   /api/v1/clips/:clipId/publish
```

Gunakan error format konsisten:

```json
{
  "error": {
    "code": "JOB_STAGE_FAILED",
    "message": "The transcription stage failed.",
    "request_id": "uuid",
    "details": {}
  }
}
```

Gunakan idempotency key pada endpoint create job, publish, retry, dan operasi penting lain.

---

# 17. Reliability dan Error Handling

1. Bedakan error user, validation, provider, temporary infrastructure, permanent media, dan internal bug.
2. Retry hanya error yang retryable.
3. Gunakan exponential backoff + jitter.
4. Circuit breaker untuk provider eksternal.
5. Provider fallback harus eksplisit dan tercatat.
6. Jangan diam-diam mengganti model jika dapat mengubah hasil/cost tanpa policy admin.
7. Activity Temporal yang lama wajib heartbeat.
8. Gunakan dead-letter handling untuk BullMQ.
9. Gunakan graceful shutdown.
10. Pastikan worker tidak mengambil job baru saat draining.
11. Gunakan checksum untuk memastikan output tidak korup.
12. Cleanup temporary file dalam finally/deferred cleanup.
13. Sediakan admin reconciliation job untuk workflow/object orphan.
14. Retry manual tidak boleh membuat output duplicate tanpa versioning.

---

# 18. Observability

## Logging

- Structured JSON log.
- Correlation fields: request_id, trace_id, user_id, job_id, workflow_id, activity_id.
- Redact authorization header, cookie, token, API key, signed URL query.
- User-facing log berbeda dari technical log.

## Metrics

Minimum metrics:

- HTTP latency/error.
- Active sessions.
- Queue depth.
- Job count by status/tool.
- Stage duration.
- Workflow retry count.
- Provider latency/error/token usage.
- Transcription duration ratio.
- FFmpeg render duration ratio.
- Storage usage.
- Publish success rate.
- Worker heartbeat.

## Tracing

Trace request Node → Temporal → Python activity → provider/MinIO.

## Alerting

- Job failure spike.
- Queue backlog.
- Worker offline.
- Temporal unavailable.
- MinIO/Postgres/Redis unavailable.
- Provider error rate tinggi.
- Disk/storage threshold.
- Publish token expiry.

---

# 19. UI/UX Requirements

1. Professional creator dashboard, bukan tampilan admin generik.
2. Responsive desktop, tablet, dan mobile.
3. Gunakan progressive disclosure: quick mode dahulu, advanced mode bila dibutuhkan.
4. Wizard dan stepper untuk tool kompleks.
5. Autosave draft.
6. Inline validation.
7. Empty state yang menjelaskan langkah berikutnya.
8. Skeleton loading.
9. Toast untuk event ringan; modal hanya untuk keputusan penting.
10. Error message menjelaskan apa yang gagal dan tindakan yang dapat dilakukan.
11. Progress tidak boleh melompat mundur kecuali workflow benar-benar diulang dan UI menjelaskannya.
12. Accessibility: keyboard navigation, label, contrast, focus state, ARIA.
13. Gunakan partial EJS reusable.
14. Hindari halaman padat. Gunakan tabs pada detail job/hasil.
15. Preview video sticky pada halaman edit clip bila sesuai.
16. Gunakan bahasa Indonesia dan English melalui i18n.

---

# 20. Coding Standards

## TypeScript

- Strict mode.
- Hindari `any`.
- Controller tipis.
- Business logic di service/use case.
- Repository membungkus akses Prisma bila memberikan nilai nyata.
- DTO/schema validation terpisah.
- Dependency injection sederhana.
- Custom error hierarchy.
- Async error handling konsisten.

## Python

- Type hints.
- Pydantic model.
- Ruff.
- Black.
- Pyright atau mypy.
- Pisahkan domain, application, infrastructure.
- Jangan menaruh seluruh workflow dalam satu file.
- Wrapper FFmpeg teruji dan command argument tidak dibangun dari string shell mentah.

## Umum

- Maksimal lebar baris sekitar 100–120 karakter.
- Pecah expression panjang ke beberapa baris.
- Nama variabel jelas.
- Hindari fungsi sangat panjang.
- Jangan membuat abstraction yang tidak dipakai.
- Tambahkan komentar untuk alasan, bukan mengulang apa yang dilakukan kode.
- Semua public/internal API penting memiliki contract.
- Tulis unit test dan integration test.

---

# 21. Testing

Buat:

1. Unit test business logic.
2. Integration test PostgreSQL/Redis/MinIO.
3. Contract test Node–Python.
4. Temporal workflow test dengan time skipping/mocked activities bila sesuai.
5. E2E test auth, upload, create job, progress, output.
6. Golden test untuk subtitle formatting.
7. Media fixture kecil untuk FFmpeg pipeline.
8. Analyzer schema validation test.
9. Retry/idempotency/cancellation test.
10. Security test untuk RBAC, CSRF, rate limiting, dan secret redaction.

Jangan menggunakan video besar di CI. Gunakan fixture singkat dan deterministic.

---

# 22. Docker Compose Development

Sediakan service:

- web-node
- media-ingestion-node
- ai-media-python
- postgres
- redis
- minio
- minio-init
- temporal
- temporal-ui
- prometheus
- grafana
- loki
- promtail atau collector

Buat healthcheck dan dependency readiness.

Auto migration:

- Gunakan service/job migration terpisah yang menjalankan `prisma migrate deploy`.
- Jangan menjalankan destructive migration otomatis.
- Web hanya start setelah migration sukses.

Sediakan `.env.example`, seed admin, bucket initialization, dan command development yang jelas.

---

# 23. Kubernetes Production

Buat manifest atau Helm chart untuk:

- Web deployment.
- Ingestion worker deployment.
- Python worker deployment.
- Temporal worker deployment bila dipisah.
- Service.
- Ingress.
- ConfigMap.
- Secret references.
- HPA.
- PodDisruptionBudget.
- Resource requests/limits.
- Liveness/readiness/startup probes.
- NetworkPolicy.
- ServiceAccount.
- Migration Job.

Scaling:

- Web scale berdasarkan CPU/request.
- Worker scale berdasarkan queue/workflow backlog dan resource.
- Pisahkan worker CPU dan GPU jika nanti dibutuhkan.
- Gunakan persistent object storage production yang sesuai; MinIO dapat dijalankan terkelola/cluster, jangan menganggap single container cukup untuk production.

---

# 24. Dokumentasi untuk Maintenance oleh AI/Engineer

Buat di root/docs:

- `README.md`: setup dan command.
- `AGENTS.md`: aturan AI saat mengubah project.
- `CONTRIBUTING.md`.
- `docs/architecture.md`.
- `docs/workflows.md`.
- `docs/database.md`.
- `docs/api.md`.
- `docs/security.md`.
- `docs/operations.md`.
- `docs/troubleshooting.md`.
- `docs/ai-maintenance-guide.md`.
- ADR untuk keputusan utama.

`AGENTS.md` harus berisi:

- Boundary Node/Python.
- Larangan menaruh FFmpeg/AI di Node.
- Larangan mengirim media besar via REST.
- Cara menambah provider/model/tool.
- Cara menambah Temporal activity.
- Cara migration.
- Testing wajib.
- Logging/redaction rules.
- Definition of done.

---

# 25. Fase Implementasi

## Phase 1 — Foundation

- Monorepo.
- Auth.
- RBAC.
- User/admin layout.
- PostgreSQL/Prisma.
- Redis.
- MinIO upload.
- Job framework.
- Temporal connection.
- Observability dasar.

## Phase 2 — Auto Clipping MVP

- Upload/source ingestion.
- faster-whisper.
- Transcript timestamp.
- LLM candidate analyzer.
- Basic scene/silence analysis.
- Basic center/face crop.
- Subtitle.
- Render.
- Preview/download.
- Retry/cancel/progress.

## Phase 3 — Advanced Clipping

- Active speaker tracking.
- Split-screen.
- Better reframing.
- Clip editor ringan.
- Brand presets.
- Quality scoring.
- Regenerate per clip.

## Phase 4 — TTS dan Transcription Tool

- TTS provider abstraction.
- Target duration assistance.
- Transcript editor.
- Subtitle export/burn.

## Phase 5 — Publishing, Billing, dan Scale

- Social OAuth/publishing.
- Quota/billing.
- Kubernetes/HPA.
- Cost dashboards.
- Provider fallback/routing.

---

# 26. Output yang Harus Anda Berikan

Kerjakan secara bertahap dan jangan langsung menumpahkan ribuan baris kode tanpa struktur.

Urutan output wajib:

1. Ringkasan pemahaman produk.
2. Asumsi dan keputusan arsitektur.
3. Diagram arsitektur dalam Mermaid.
4. Diagram workflow auto clipping dalam Mermaid.
5. Struktur repository final.
6. Modul dan tanggung jawabnya.
7. Database ERD dan Prisma schema awal.
8. Job state machine.
9. API contract utama.
10. UI sitemap dan halaman utama.
11. Threat model dan security checklist.
12. Docker Compose development.
13. Kubernetes production plan.
14. Roadmap implementasi per fase.
15. Setelah itu mulai generate source code Phase 1 file demi file.

Saat menghasilkan kode:

- Selalu tulis path file sebelum code block.
- Jangan gunakan placeholder seperti “implement here” untuk bagian inti.
- Jangan melewati error handling.
- Jangan hardcode secret.
- Sertakan test untuk logic penting.
- Sertakan migration.
- Sertakan cara menjalankan.
- Pastikan project dapat dikembangkan secara lokal.
- Jangan mengubah arsitektur tanpa menjelaskan trade-off.

---

# 27. Acceptance Criteria Utama

Project dianggap memenuhi kebutuhan awal jika:

1. User dapat register/login/Google login/reset password.
2. Superadmin memiliki dashboard dan CRUD user/provider/model.
3. User dapat upload video besar langsung ke MinIO.
4. User dapat membuat auto clipping job.
5. Job berjalan background, memiliki progress real-time, log, retry, dan cancel.
6. Workflow tahan restart melalui Temporal.
7. Python menghasilkan transcript bertimestamp.
8. LLM menghasilkan kandidat clip JSON tervalidasi.
9. Pipeline menghasilkan clip final dengan crop dan subtitle.
10. Hasil dapat dipreview dan di-download.
11. Setiap clip memiliki score dan breakdown.
12. User dapat regenerate dengan input sebelumnya.
13. Media tersusun berdasarkan user/job di MinIO.
14. Credential AI dapat berasal dari user atau platform.
15. Secret terenkripsi dan tidak bocor ke log.
16. Admin dapat melihat health job/worker/provider.
17. Docker Compose dapat menjalankan environment development.
18. Arsitektur siap di-scale di Kubernetes.
19. Dokumentasi maintenance tersedia.
20. Test inti lulus.

Mulai dengan bagian **Ringkasan Pemahaman Produk dan Keputusan Arsitektur**, lalu lanjutkan sesuai urutan output di atas.


hasilnya simpan di ZIP