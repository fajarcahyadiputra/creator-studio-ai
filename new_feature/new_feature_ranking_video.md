ANDA ADALAH SENIOR FULL-STACK ENGINEER, PYTHON ENGINEER, VIDEO PROCESSING ENGINEER, DAN AI ENGINEER.

Tambahkan fitur baru bernama “Create Ranking Video” ke website content creator yang sudah ada.

Jangan membuat ulang project. Pelajari terlebih dahulu arsitektur, coding style, autentikasi, database, storage, queue, dan komponen UI existing. Implementasikan fitur secara modular, aman, mudah dirawat, dan tidak merusak fitur lain.

TUJUAN FITUR

User dapat membuat video ranking seperti konten TikTok, YouTube Shorts, atau Instagram Reels.

Alur utama:

Create Ranking Video
→ Buat project
→ Tentukan judul dan jumlah ranking
→ Tambah item ranking secara dinamis
→ Setiap item memakai video berbeda
→ Pilih sumber video
→ Pilih mode Manual Cut atau Auto AI
→ Atur bagian video
→ Preview
→ Generate final video
→ Download hasil

SETIAP ITEM RANKING MEMILIKI

- nomor ranking;
- judul moment;
- emoji opsional;
- upload video atau link video;
- mode cut;
- start time;
- end time;
- durasi;
- crop dan posisi video;
- volume;
- transition;
- status proses.

Sumber video:

- upload file;
- YouTube;
- TikTok;
- Facebook.

Gunakan yt-dlp hanya untuk URL yang didukung dan tidak dilindungi login, CAPTCHA, DRM, atau pembatasan platform. Sediakan upload manual sebagai fallback.

MANUAL CUT

User harus dapat memilih langsung bagian video di website.

Buat editor yang memiliki:

- video player;
- timeline;
- thumbnail frame;
- playhead;
- start handle;
- end handle;
- input start time;
- input end time;
- durasi clip;
- tombol Set Start;
- tombol Set End;
- tombol Preview Clip;
- tombol Reset;
- tombol Save Clip.

User dapat:

- menggeser batas awal dan akhir;
- menentukan start dan end dari posisi video;
- memasukkan timestamp manual;
- melihat preview hanya pada bagian yang dipilih;
- mengubah ulang potongan sebelum disimpan.

Gunakan waktu dalam integer milliseconds.

Jangan menjalankan FFmpeg setiap slider berubah. Frontend hanya menyimpan start dan end. FFmpeg dijalankan saat membuat preview server-side atau final render.

AUTO AI

Mode Auto AI digunakan untuk mencari moment terbaik secara otomatis.

Proses:

1. Ekstrak audio dan transcript bertimestamp.
2. Deteksi scene, silence, motion, dan perubahan audio.
3. Buat beberapa kandidat clip.
4. Kirim transcript dan metadata kandidat ke OpenAI.
5. OpenAI memilih moment terbaik dan mengembalikan JSON terstruktur.
6. Tampilkan beberapa rekomendasi.
7. User dapat preview, memilih, lalu mengedit hasil AI melalui Manual Cut Editor.

Contoh output AI:

{
"recommended_clips": [
{
"start_time_ms": 24500,
"end_time_ms": 32800,
"score": 94,
"reason": "Momen utama terjadi pada bagian ini.",
"suggested_title": "Unexpected Landing"
}
]
}

Hasil AI tidak boleh langsung dianggap final.

LAYOUT VIDEO

Hasil video memiliki:

- header judul;
- daftar nomor dan nama ranking;
- video utama;
- nomor aktif yang di-highlight;
- subtitle opsional;
- watermark;
- background music;
- transition.

Contoh:

Ranking Funniest Parkour Moments

1. Bullseye
2. Crocodile
3. Folded ← aktif
4. Vanished
5. Perfect Landing

Jumlah item harus dinamis. Jika daftar terlalu panjang, tampilkan item aktif dan beberapa item di sekitarnya.

Sediakan template:

- Classic Ranking;
- Bold Viral;
- Minimal Clean;
- Gaming;
- Comedy.

User dapat mengatur font, ukuran teks, warna aktif, posisi daftar, background, crop, padding, dan watermark.

STACK

Backend:

- Python;
- FastAPI;
- FFmpeg;
- FFprobe;
- yt-dlp;
- OpenAI API;
- Redis;
- Celery, RQ, atau worker existing.

Frontend:

- gunakan framework existing;
- HTML5 Video, Video.js, atau library yang sesuai;
- timeline editor;
- drag and drop reorder;
- autosave.

Storage:

- gunakan storage existing;
- dukung local development dan S3/MinIO.

BACKGROUND JOB

Semua proses berat harus berjalan melalui worker:

- download video;
- ffprobe;
- transcode proxy;
- generate thumbnail;
- generate timeline thumbnail;
- transcription;
- AI analysis;
- render preview;
- final render;
- cleanup temporary file.

Job harus memiliki:

- progress;
- retry;
- timeout;
- error message;
- logging;
- status;
- idempotency.

DATABASE

Tambahkan entity minimal:

ranking_video_projects

- id;
- user_id;
- title;
- ranking_title;
- aspect_ratio;
- width;
- height;
- fps;
- template;
- settings_json;
- status;
- progress;
- output_file_id;
- error_message;
- timestamps.

ranking_video_items

- id;
- project_id;
- rank_number;
- title;
- source_type;
- source_url;
- source_file_id;
- proxy_file_id;
- source_duration_ms;
- cut_mode;
- start_time_ms;
- end_time_ms;
- crop_json;
- style_json;
- audio_json;
- status;
- error_message;
- timestamps.

ranking_video_jobs

- id;
- project_id;
- type;
- status;
- progress;
- current_step;
- attempts;
- error_message;
- timestamps.

Fitur selesai jika:

1. User dapat membuat project ranking.
2. User dapat menambah dan mengurutkan item secara dinamis.
3. Setiap item dapat memakai video berbeda.
4. User dapat upload video atau memasukkan URL.
5. User dapat memilih Manual Cut.
6. User dapat memilih bagian video melalui timeline.
7. User dapat preview bagian yang dipilih.
8. User dapat memilih Auto AI.
9. Hasil AI dapat diedit manual.
10. User dapat mengatur crop dan layout.
11. User dapat melihat preview keseluruhan.
12. Final render berjalan di background worker.
13. Progress tampil di frontend.
14. Hasil dapat diputar dan di-download.
15. Error ditampilkan dengan jelas.
16. Test dan dokumentasi tersedia.

CARA KERJA

Sebelum coding:

1. Audit project existing.
2. Jelaskan arsitektur saat ini.
3. Buat daftar file yang ditambah dan diubah.
4. Buat database schema.
5. Buat API design.
6. Buat video processing flow.
7. Buat implementation plan bertahap.

Setelah disetujui, implementasikan fitur secara bertahap dengan kode lengkap, migration, test, error handling, dokumentasi, dan konfigurasi Docker jika diperlukan.

Jangan gunakan pseudo-code untuk bagian utama dan jangan meninggalkan TODO pada proses inti.
