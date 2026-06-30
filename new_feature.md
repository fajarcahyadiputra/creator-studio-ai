# MASTER PROMPT — TAMBAHKAN FEATURE AI CREATE VIDEO KE WEBSITE EXISTING

Anda adalah Senior Software Architect, Senior Full-Stack Engineer, Senior Python Engineer, dan Video Processing Engineer.

Tugas Anda adalah MENAMBAHKAN feature baru bernama **Create Video** ke website content creator yang SUDAH EXISTING.

Pada feature Create Video, user harus dapat memilih salah satu sumber audio berikut:

- Upload Audio Sendiri
- Generate Audio dari Naskah
- Tanpa Audio Narator, jika feature ini diizinkan oleh konfigurasi produk

Jangan membangun ulang seluruh website dari awal.

Pelajari terlebih dahulu:

- struktur project existing
- framework yang digunakan
- pola authentication
- pola authorization
- database schema
- API convention
- coding standard
- folder structure
- queue atau background job yang sudah tersedia
- storage yang sudah digunakan
- UI design system
- error handling
- logging
- deployment configuration

Feature baru harus mengikuti arsitektur, style, naming convention, dan pola implementasi website existing.

==================================================
TUJUAN FEATURE
==============

Tambahkan menu baru:

Create Video

Feature ini memungkinkan user membuat video otomatis dari:

- beberapa gambar
- naskah
- audio narator opsional
- background music opsional
- konfigurasi video

Sistem akan:

1. menerima upload beberapa gambar
2. menerima input naskah
3. menerima audio narator atau menghasilkan audio dari TTS
4. menganalisis naskah
5. membagi naskah menjadi beberapa scene
6. mencocokkan gambar dengan scene
7. membuat timeline video
8. menambahkan animasi pada gambar
9. menambahkan subtitle
10. mencampurkan audio dan background music
11. merender video
12. menyimpan hasil video
13. menampilkan hasil ke dashboard user

Proses harus berjalan di background sehingga user dapat meninggalkan halaman website setelah job dimulai.

==================================================
BATASAN IMPLEMENTASI
====================

Jangan:

- mengganti arsitektur utama project tanpa alasan kuat
- mengganti authentication existing
- membuat database baru jika database existing masih dapat digunakan
- membuat frontend terpisah jika website sudah memiliki frontend
- membuat design system baru
- memproses render video langsung di HTTP request
- menyimpan video besar di database
- membuat terlalu banyak microservice untuk MVP
- merusak feature existing
- mengubah API existing yang tidak berkaitan
- menulis ulang module yang sudah berjalan

Gunakan extension dan integration, bukan rewrite.

==================================================
TAHAP AWAL WAJIB
================

Sebelum menulis implementasi:

1. Analisis struktur project existing.
2. Identifikasi teknologi yang digunakan.
3. Identifikasi module yang bisa digunakan kembali.
4. Identifikasi perubahan database yang diperlukan.
5. Identifikasi integration point.
6. Buat daftar file yang akan ditambah.
7. Buat daftar file existing yang akan diubah.
8. Jelaskan risiko perubahan terhadap feature existing.
9. Buat migration plan yang aman.
10. Buat implementation plan bertahap.

Jangan langsung menghasilkan kode sebelum memahami project existing.

Jika terdapat pola existing untuk:

- controller
- service
- repository
- use case
- DTO
- entity
- worker
- queue
- storage
- event
- notification

ikuti pola tersebut.

==================================================
FITUR USER
==========

Tambahkan halaman Create Video dengan input:

- project title
- beberapa gambar
- naskah
- audio narator opsional
- pilihan generate suara
- background music opsional
- aspect ratio
- resolution
- subtitle style
- video style
- transition style
- output quality

Pilihan aspect ratio:

- 9:16
- 16:9
- 1:1
- 4:5

Default:

- ratio: 9:16
- resolution: 1080x1920
- frame rate: 30 FPS
- output format: MP4
- video codec: H.264
- audio codec: AAC

==================================================
ALUR USER
=========

Alur penggunaan:

1. User membuka menu Create Video.
2. User membuat project.
3. User mengunggah gambar.
4. User memasukkan naskah.
5. User memilih atau mengunggah audio.
6. User memilih konfigurasi video.
7. User menekan tombol Create Video.
8. Backend membuat background job.
9. User dapat meninggalkan halaman.
10. Worker memproses video.
11. Website menampilkan progress.
12. Setelah selesai, user dapat preview dan download video.
13. User dapat melakukan render ulang jika diperlukan.

==================================================
STATUS JOB
==========

Gunakan status berikut:

- draft
- pending
- validating_assets
- analyzing_images
- preparing_audio
- transcribing
- analyzing_script
- matching_images
- building_timeline
- generating_subtitles
- rendering
- uploading_result
- completed
- failed
- cancelled

Progress harus berdasarkan tahapan nyata.

Contoh response:

{
"id": "job_123",
"status": "analyzing_images",
"progress": 25,
"currentStep": "Analyzing image 5 of 20",
"error": null
}

Jangan menampilkan progress acak.

==================================================
PEMBAGIAN TANGGUNG JAWAB
========================

Gunakan backend website existing untuk:

- authentication
- authorization
- user management
- project management
- asset metadata
- create job
- job status
- billing atau quota
- notification
- API untuk frontend

Gunakan Python worker untuk:

- image analysis
- audio preparation
- transcription
- scene matching
- subtitle generation
- timeline building
- video rendering
- output validation

Backend utama tidak boleh melakukan rendering video langsung.

==================================================
INTEGRASI BACKGROUND PROCESS
============================

Gunakan queue yang sudah ada di project.

Jika belum tersedia, gunakan salah satu:

- Redis Streams
- RabbitMQ
- BullMQ jika worker masih berbasis Node.js
- Celery jika seluruh worker Python
- Dramatiq atau RQ sebagai alternatif Python

Rekomendasi:

- Node.js sebagai API dan orchestrator
- Python sebagai media-processing worker
- RabbitMQ atau Redis Streams sebagai message broker

Setiap job harus:

- idempotent
- memiliki retry
- memiliki timeout
- menyimpan error detail
- dapat dilanjutkan tanpa mengulang semua proses
- dapat dibatalkan
- dapat diproses ulang

==================================================
TEKNOLOGI OPEN SOURCE PYTHON
============================

Gunakan teknologi open source sebanyak mungkin.

Video rendering:

- FFmpeg
- PyAV

Image processing:

- OpenCV
- Pillow
- NumPy

Transcription:

- faster-whisper
- CTranslate2

Subtitle:

- pysubs2
- ASS
- SRT

Voice Activity Detection:

- Silero VAD
- WebRTC VAD

Image embedding:

- OpenCLIP
- SigLIP
- SentenceTransformers

Image captioning opsional:

- Florence-2
- BLIP
- BLIP-2
- Qwen-VL lokal

Object dan face detection:

- MediaPipe
- OpenCV DNN
- Ultralytics YOLO

OCR:

- PaddleOCR
- EasyOCR
- Tesseract

Audio processing:

- FFmpeg
- librosa
- pyloudnorm
- pydub bila diperlukan

TTS opsional:

- Piper
- Kokoro
- Coqui TTS
- XTTS

Jangan menggunakan MoviePy sebagai render engine utama.

MoviePy boleh digunakan hanya untuk prototyping atau fungsi sederhana.

==================================================
PENGGUNAAN LLM
==============

Gunakan abstraction layer untuk LLM.

Provider dapat berupa:

- OpenAI GPT-5.4
- OpenAI model lain
- Gemini
- Claude
- local LLM

LLM hanya digunakan untuk reasoning seperti:

- membagi naskah menjadi scene
- menentukan tone
- menentukan pacing
- menentukan kebutuhan visual
- membuat visual query
- menentukan kata penting
- menentukan motion suggestion
- menentukan transition suggestion
- membuat title dan metadata

LLM tidak boleh:

- melakukan rendering video
- menentukan timestamp final tanpa audio
- mengarang isi gambar
- menentukan durasi audio berdasarkan tebakan
- memproses frame video

Output LLM harus berupa JSON valid dan tervalidasi dengan JSON Schema atau Pydantic.

==================================================
ALUR PROSES VIDEO
=================

STEP 1 — Validasi Input

Validasi:

- minimal satu gambar
- naskah tidak kosong
- tipe file
- ukuran file
- dimensi gambar
- audio codec
- file corrupt
- quota user
- total durasi
- ownership asset

STEP 2 — Image Analysis

Untuk setiap gambar:

- perbaiki orientation
- buat thumbnail
- deteksi blur
- deteksi brightness
- deteksi wajah
- deteksi objek
- OCR
- buat embedding
- buat safe crop
- buat metadata visual

Contoh metadata:

{
"imageId": "img_001",
"description": "Pesawat militer di landasan",
"objects": ["aircraft", "soldier"],
"faces": [],
"ocrTexts": [],
"tags": ["history", "military"],
"qualityScore": 0.9,
"safeCrop": {
"x": 100,
"y": 50,
"width": 1200,
"height": 1700
}
}

Jika sistem tidak yakin, gunakan:

- unknown
- null
- array kosong

Jangan mengarang metadata.

STEP 3 — Audio Preparation

Jika user upload audio:

- validasi audio
- normalize loudness
- convert ke format internal
- deteksi silence
- transcribe
- hasilkan word timestamp

Jika user tidak upload audio:

- generate audio dengan TTS
- lakukan alignment atau transcription ulang
- hasilkan word timestamp

Audio menjadi sumber utama durasi video.

STEP 4 — Script Analysis

Gunakan LLM untuk membagi naskah menjadi semantic scene berdasarkan:

- topik
- lokasi
- tokoh
- waktu
- emosi
- kebutuhan visual
- punchline
- perubahan konteks

Contoh output:

{
"scenes": [
{
"id": "scene_001",
"narrationText": "Pada tahun 1974 terjadi peristiwa mengejutkan.",
"visualQuery": "historical Indonesia 1974",
"keywords": ["Indonesia", "1974"],
"emotion": "mysterious",
"pacing": "slow",
"motion": "slow_zoom_in",
"transition": "fade",
"subtitleEmphasis": ["1974", "mengejutkan"]
}
]
}

LLM tidak boleh mengisi timestamp final.

STEP 5 — Audio Alignment

Cocokkan scene dengan word timestamp.

Timestamp final harus berasal dari:

- audio
- transcription
- forced alignment
- speech pause

Bukan dari tebakan LLM.

STEP 6 — Scene-to-Image Matching

Cocokkan gambar dengan scene berdasarkan:

- semantic similarity
- keyword match
- object match
- emotion match
- OCR match
- image quality
- crop suitability
- repetition penalty

Jangan memilih gambar berdasarkan urutan upload saja.

STEP 7 — Timeline Builder

Bangun timeline final:

- scene start
- scene end
- image
- subtitle
- camera movement
- transition
- background music
- audio level

Durasi scene mengikuti audio.

Jika satu gambar terlalu lama, sistem dapat:

- menggunakan gambar tambahan
- menggunakan crop berbeda
- menggunakan motion berbeda
- menggunakan zoom berbeda
- membuat split visual
- menggunakan background blur

STEP 8 — Video Rendering

Gunakan FFmpeg sebagai final rendering engine.

Output default:

- MP4
- H.264
- AAC
- yuv420p
- 30 FPS
- faststart aktif

STEP 9 — Quality Validation

Gunakan ffprobe untuk memeriksa:

- video dapat diputar
- resolusi benar
- durasi benar
- audio tersedia
- codec benar
- subtitle tidak keluar layar
- tidak ada black frame panjang
- file tidak corrupt

Job hanya boleh menjadi completed setelah validasi berhasil.

==================================================
CAMERA MOVEMENT
===============

Sediakan:

- static
- zoom_in
- zoom_out
- pan_left
- pan_right
- tilt_up
- tilt_down
- ken_burns
- focus_subject

Gerakan harus:

- smooth
- menggunakan easing
- tidak memotong wajah
- tidak memotong objek utama
- tidak menampilkan area kosong
- tidak dipilih secara random

==================================================
SUBTITLE
========

Subtitle harus:

- sinkron dengan audio
- maksimal dua baris
- mudah dibaca
- tidak menutup wajah
- tidak menutup objek penting
- tidak menutup teks pada gambar
- menggunakan safe margin
- dibagi berdasarkan frasa alami

Default:

- 3 sampai 7 kata per phrase
- maksimal 42 karakter per baris
- maksimal dua baris
- format ASS untuk render
- format SRT untuk download

Dukung style:

- clean
- bold
- cinematic
- documentary
- minimal
- karaoke

Dukung active-word highlighting berdasarkan word timestamp.

==================================================
BACKGROUND MUSIC
================

Background music opsional.

Sistem harus:

- melakukan loop dengan halus
- fade in
- fade out
- audio ducking
- loudness normalization
- mencegah clipping
- menjaga suara narator tetap dominan

Jangan otomatis menggunakan musik berhak cipta.

==================================================
DATABASE
========

Tambahkan tabel sesuai pola database existing.

Minimal entity:

video_projects

- id
- user_id
- title
- script
- aspect_ratio
- resolution
- fps
- style
- subtitle_style
- status
- created_at
- updated_at

video_assets

- id
- project_id
- asset_type
- storage_key
- mime_type
- file_size
- metadata
- created_at

video_jobs

- id
- project_id
- status
- progress
- current_stage
- retry_count
- error_code
- error_message
- started_at
- completed_at
- created_at
- updated_at

video_scenes

- id
- project_id
- scene_order
- narration_text
- start_sec
- end_sec
- visual_query
- selected_asset_id
- motion
- transition
- metadata

video_outputs

- id
- project_id
- job_id
- output_type
- storage_key
- duration_sec
- resolution
- file_size
- created_at

Sesuaikan nama tabel dan kolom dengan convention project existing.

Gunakan migration baru.

Jangan mengubah migration lama.

==================================================
API ENDPOINT
============

Sesuaikan endpoint dengan style API existing.

Contoh:

POST /api/video-projects
GET /api/video-projects
GET /api/video-projects/:id
PATCH /api/video-projects/:id
DELETE /api/video-projects/:id

POST /api/video-projects/:id/assets/upload-url
POST /api/video-projects/:id/render
GET /api/video-projects/:id/jobs
GET /api/video-jobs/:id
POST /api/video-jobs/:id/retry
POST /api/video-jobs/:id/cancel

GET /api/video-projects/:id/scenes
PATCH /api/video-projects/:id/scenes

GET /api/video-projects/:id/outputs
GET /api/video-outputs/:id/download-url

Gunakan endpoint yang konsisten dengan routing existing.

==================================================
FRONTEND
========

Tambahkan menu Create Video ke navigasi existing.

Gunakan:

- layout existing
- component existing
- form component existing
- notification existing
- loading state existing
- modal existing
- design token existing
- validation style existing

Halaman yang diperlukan:

1. Daftar video project
2. Create project
3. Upload asset
4. Video configuration
5. Job progress
6. Preview result
7. Edit scene sederhana
8. Download result

UI progress harus menampilkan:

- status
- persentase
- current stage
- error
- retry
- cancel

Gunakan polling, Server-Sent Events, atau WebSocket sesuai arsitektur existing.

==================================================
QUOTA DAN BILLING
=================

Jika website existing memiliki subscription atau quota, integrasikan feature ini.

Quota dapat berdasarkan:

- jumlah render
- durasi output
- durasi audio
- resolusi
- storage
- penggunaan GPU
- penggunaan LLM

Lakukan quota reservation sebelum job diproses.

Kembalikan quota apabila job gagal karena kesalahan sistem sesuai kebijakan.

Jangan mengurangi quota dua kali saat retry.

==================================================
SECURITY
========

Implementasikan:

- ownership validation
- signed upload URL
- signed download URL
- private object storage
- MIME validation
- magic byte validation
- file size limit
- input sanitization
- rate limiting
- safe FFmpeg argument
- timeout
- authorization per project
- path traversal prevention

Jangan membuat command shell FFmpeg dengan string mentah dari input user.

==================================================
ERROR HANDLING
==============

Tangani:

- file corrupt
- upload gagal
- audio tanpa suara
- image analysis gagal
- transcription gagal
- output LLM invalid
- storage timeout
- FFmpeg gagal
- worker crash
- out of memory
- job duplicate
- user cancel
- quota tidak cukup

Gunakan:

- retry dengan exponential backoff
- maximum retry
- dead-letter queue
- structured error code
- cleanup temporary files

Jika render gagal, jangan ulangi transcription atau image analysis jika hasil sebelumnya masih valid.

==================================================
OBSERVABILITY
=============

Gunakan logging dan monitoring yang sudah digunakan project existing.

Setiap log minimal memiliki:

- requestId
- userId
- projectId
- jobId
- workerId
- stage
- errorCode

Pantau:

- queue depth
- job duration
- failure rate
- retry count
- render duration
- transcription duration
- CPU
- memory
- GPU jika tersedia
- storage usage

==================================================
STRUKTUR PYTHON WORKER
======================

Tambahkan worker secara modular.

Contoh:

python-worker/
├── src/
│ ├── application/
│ ├── domain/
│ ├── infrastructure/
│ ├── workers/
│ ├── image_analysis/
│ ├── audio_processing/
│ ├── transcription/
│ ├── script_analysis/
│ ├── scene_matching/
│ ├── timeline/
│ ├── subtitle/
│ ├── animation/
│ ├── rendering/
│ ├── storage/
│ └── observability/
├── tests/
├── Dockerfile
├── requirements.txt
└── README.md

Gunakan:

- type hints
- Pydantic
- structured logging
- dependency injection seperlunya
- repository abstraction
- storage abstraction
- LLM provider abstraction
- TTS provider abstraction

==================================================
MVP YANG WAJIB
==============

Implementasikan terlebih dahulu:

- tambah menu Create Video
- create video project
- upload beberapa gambar
- input naskah
- upload audio narator
- transcription faster-whisper
- script scene analysis
- image matching
- pan dan zoom dasar
- subtitle ASS
- background music opsional
- render FFmpeg
- progress job
- retry
- cancel
- preview
- download
- validation output

Fitur opsional setelah MVP:

- local TTS
- edit timeline
- edit subtitle
- reorder image
- multiple visual per scene
- advanced transition
- parallax
- generated image
- generated B-roll
- auto thumbnail
- social media publishing

==================================================
HASIL IMPLEMENTASI YANG DIMINTA
===============================

Berikan hasil dengan urutan berikut:

1. Analisis project existing
2. Integration plan
3. Daftar file baru
4. Daftar file yang diubah
5. Database migration
6. Entity dan schema
7. API contract
8. Event contract
9. Backend implementation
10. Python worker implementation
11. Frontend implementation
12. Queue integration
13. Storage integration
14. Docker configuration
15. Environment variables
16. Unit test
17. Integration test
18. Migration guide
19. Deployment guide
20. Rollback plan
21. Dokumentasi feature

Jangan membangun ulang website.

Tambahkan feature Create Video secara aman, modular, dan konsisten dengan project existing.

Jangan hanya memberikan pseudocode.

Implementasi utama harus dapat dijalankan dan terintegrasi dengan website existing.
