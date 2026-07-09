Berikut versi yang jauh lebih ringkas, tetapi tetap mencakup kebutuhan utamanya dari prompt yang Anda kirim.

```text
ANDA ADALAH SENIOR SOFTWARE ARCHITECT, FULL-STACK ENGINEER, PYTHON ENGINEER, DAN VIDEO PROCESSING ENGINEER.

Tambahkan feature baru bernama “Create Video” ke website content creator yang sudah existing.

Jangan membangun ulang project. Pelajari terlebih dahulu arsitektur, framework, authentication, database, API convention, queue, storage, UI component, coding style, logging, dan deployment existing. Semua implementasi wajib mengikuti pola project yang sudah ada dan tidak merusak feature existing.

TUJUAN FEATURE

User dapat membuat video otomatis dari:

- beberapa gambar;
- naskah;
- upload audio narator;
- generate audio dari naskah;
- tanpa audio narator jika diizinkan;
- background music opsional;
- subtitle;
- animasi gambar;
- konfigurasi output video.

Alur:

Create Video
→ Buat project
→ Upload gambar
→ Input naskah
→ Pilih audio
→ Atur video
→ Proses di background
→ Tampilkan progress
→ Preview
→ Download hasil

INPUT USER

- project title;
- beberapa gambar;
- naskah;
- audio upload atau TTS;
- background music;
- aspect ratio;
- resolution;
- subtitle style;
- video style;
- transition;
- output quality.

Default output:

- MP4;
- H.264;
- AAC;
- 1080 × 1920;
- 30 FPS;
- aspect ratio 9:16;
- yuv420p;
- faststart.

ARSITEKTUR

Gunakan backend existing untuk:

- authentication;
- authorization;
- project management;
- asset metadata;
- quota;
- job status;
- notification;
- API frontend.

Gunakan Python worker untuk:

- image analysis;
- audio processing;
- transcription;
- script analysis;
- scene matching;
- subtitle generation;
- timeline building;
- rendering;
- output validation.

Jangan render video langsung di HTTP request.

Gunakan queue existing. Jika belum tersedia, gunakan Redis, RabbitMQ, Celery, RQ, Dramatiq, atau teknologi yang paling sesuai dengan project.

Setiap job harus:

- idempotent;
- retryable;
- memiliki timeout;
- memiliki progress nyata;
- dapat dibatalkan;
- menyimpan error;
- dapat dilanjutkan tanpa mengulang semua tahap.

VIDEO PROCESSING FLOW

1. Validasi file, quota, ownership, ukuran, tipe, dan durasi.
2. Analisis gambar:
   - orientation;
   - blur;
   - brightness;
   - face/object detection;
   - OCR;
   - embedding;
   - safe crop.
3. Siapkan audio:
   - upload atau TTS;
   - normalize;
   - detect silence;
   - transcription;
   - word timestamp.
4. Gunakan LLM untuk:
   - membagi naskah menjadi scene;
   - menentukan tone;
   - pacing;
   - visual query;
   - motion;
   - transition;
   - subtitle emphasis.
5. Cocokkan scene dengan timestamp audio.
6. Cocokkan gambar dengan scene berdasarkan semantic similarity, keyword, object, OCR, emotion, quality, dan repetition penalty.
7. Bangun timeline.
8. Tambahkan pan, zoom, transition, subtitle, audio, dan background music.
9. Render dengan FFmpeg.
10. Validasi hasil menggunakan ffprobe.

Audio menjadi sumber utama durasi video. LLM tidak boleh menebak timestamp final.

TEKNOLOGI

Prioritaskan teknologi open source:

- FFmpeg;
- FFprobe;
- PyAV;
- OpenCV;
- Pillow;
- NumPy;
- faster-whisper;
- CTranslate2;
- pysubs2;
- Silero VAD;
- OpenCLIP atau SentenceTransformers;
- librosa;
- pyloudnorm;
- Piper, Kokoro, Coqui TTS, atau XTTS.

Jangan gunakan MoviePy sebagai render engine utama.

LLM

Buat abstraction layer agar provider dapat diganti:

- OpenAI;
- Gemini;
- Claude;
- local LLM.

Output LLM wajib JSON valid dan divalidasi dengan Pydantic atau JSON Schema.

LLM hanya digunakan untuk reasoning, bukan untuk rendering atau menentukan timestamp tanpa audio.

SUBTITLE

Subtitle harus:

- sinkron dengan audio;
- maksimal dua baris;
- menggunakan safe margin;
- tidak menutup wajah atau objek penting;
- mendukung format ASS dan SRT;
- mendukung active-word highlight.

Style minimal:

- clean;
- bold;
- cinematic;
- documentary;
- minimal;
- karaoke.

BACKGROUND MUSIC

Background music harus mendukung:

- loop;
- fade in/out;
- audio ducking;
- loudness normalization;
- anti-clipping.

Jangan otomatis menggunakan musik berhak cipta.

DATABASE

Sesuaikan dengan schema existing. Minimal tambahkan entity:

video_projects
- id;
- user_id;
- title;
- script;
- aspect_ratio;
- resolution;
- fps;
- style;
- subtitle_style;
- status;
- timestamps.

video_assets
- id;
- project_id;
- asset_type;
- storage_key;
- mime_type;
- file_size;
- metadata;
- timestamps.

video_jobs
- id;
- project_id;
- status;
- progress;
- current_stage;
- retry_count;
- error_code;
- error_message;
- timestamps.

video_scenes
- id;
- project_id;
- scene_order;
- narration_text;
- start_sec;
- end_sec;
- selected_asset_id;
- motion;
- transition;
- metadata.

video_outputs
- id;
- project_id;
- job_id;
- storage_key;
- duration_sec;
- resolution;
- file_size;
- timestamps.

Gunakan migration baru. Jangan mengubah migration lama.

FRONTEND

Tambahkan menu do tools Create Video dengan halaman:

- project list;
- create project;
- asset upload;
- video configuration;
- job progress;
- preview;
- simple scene editor;
- download result.

Gunakan component dan design system existing.

Progress harus menampilkan:

- status;
- persentase;
- tahap saat ini;
- error;
- retry;
- cancel.


MVP

Implementasikan terlebih dahulu:

- menu Create Video;
- create project;
- upload beberapa gambar;
- input naskah;
- upload audio;
- optional TTS;
- faster-whisper transcription;
- scene analysis;
- image matching;
- pan dan zoom dasar;
- subtitle ASS;
- background music;
- FFmpeg rendering;
- progress;
- retry;
- cancel;
- preview;
- download;
- output validation.

TAHAP AWAL

Sebelum coding:

1. Analisis project existing.
2. Identifikasi module yang dapat digunakan kembali.
3. Buat integration plan.
4. Buat daftar file baru dan file yang diubah.
5. Buat database migration plan.
6. Buat API dan event contract.
7. Buat worker flow.
8. Jelaskan risiko implementasi.
9. Buat implementation plan bertahap.

Setelah analisis, implementasikan dengan kode lengkap, migration, worker, frontend, queue, storage, Docker, environment variable, testing, deployment guide, rollback plan, dan dokumentasi.

Jangan hanya memberikan pseudocode. Implementasi utama harus dapat dijalankan dan terintegrasi dengan project existing.
```
