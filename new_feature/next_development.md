Berikut versi yang dibagi menjadi beberapa fase pengembangan agar lebih mudah dikerjakan dan diuji.

# Development Plan — Token, Package, Payment, dan Data Retention

## Phase 1 — Token Quota dan Token Pricing

### Tugas

Tambahkan sistem saldo token untuk setiap user.

Token digunakan untuk:

- Membuat proses Auto Clipping baru.
- Regenerate Clip.
- Generate TTS.

Sebelum job dijalankan, sistem harus memeriksa saldo token user.

Gunakan mekanisme berikut:

1. Token di-reserve ketika job dibuat.
2. Jika job berhasil, token dikonfirmasi sebagai terpakai.
3. Jika job gagal karena kesalahan sistem, token dikembalikan.
4. Retry job tidak boleh menyebabkan token terpotong dua kali.

Admin dapat menentukan biaya token untuk setiap mode Auto Clipping:

- Crop Center.
- Auto Reframe Umum.
- Smart Speaker Adaptif 1–4 wajah.
- Speaker and Screen Share.

Untuk layout 9:16 berikut:

- Podcast Spotlight.
- Branded Frame.

Biaya token mengikuti biaya `Crop Center`.

Admin juga dapat menentukan biaya tambahan untuk video YouTube dengan durasi lebih dari 59 menit.

Untuk Generate TTS, admin dapat menentukan biaya token berdasarkan segmentation mode:

- OpenAI.
- Local Heuristic.

User harus dapat melihat estimasi biaya token sebelum menjalankan Auto Clipping atau Generate TTS.

### Acceptance Criteria

- Setiap user memiliki saldo token.
- User tidak dapat menjalankan job jika token tidak cukup.
- Biaya token dapat diatur dari halaman admin.
- Setiap mode crop dapat memiliki biaya token berbeda.
- Podcast Spotlight dan Branded Frame menggunakan biaya Crop Center.
- Video YouTube lebih dari 59 menit mendapatkan biaya tambahan.
- OpenAI dan Local Heuristic dapat memiliki biaya token berbeda.
- Token hanya dipotong satu kali untuk setiap job.
- Token dikembalikan jika proses gagal karena kesalahan sistem.
- Regenerate Clip juga menggunakan token.
- Retry job tidak menyebabkan double deduction.
- User dapat melihat estimasi biaya sebelum proses dijalankan.

### Struktur Teknis yang Disarankan

Buat modul:

- `TokenWallet`
- `TokenLedger`
- `TokenPricing`
- `TokenReservation`
- `TokenRefund`

Tabel utama:

- `user_token_wallets`
- `token_ledgers`
- `token_pricing_rules`
- `token_reservations`

Status token reservation:

- `reserved`
- `committed`
- `refunded`
- `expired`

Jenis token ledger:

- `usage`
- `purchase`
- `refund`
- `admin_adjustment`
- `bonus`

Gunakan database transaction dan row locking ketika mengubah saldo token.

Event yang disarankan:

- `token.reserved`
- `token.committed`
- `token.refunded`
- `token.insufficient`
- `clipping.completed`
- `clipping.failed`
- `tts.completed`
- `tts.failed`

---

# Phase 2 — Manajemen Token dan Riwayat Penggunaan

## Tugas

Tambahkan halaman admin untuk:

- Melihat saldo token setiap user.
- Menambahkan token user.
- Mengurangi atau mengoreksi token user.
- Melihat total penggunaan token.
- Melihat riwayat token masuk dan keluar.
- Melihat referensi job atau transaksi.
- Melihat alasan perubahan token.
- Melihat admin yang melakukan perubahan.

Tambahkan halaman user untuk:

- Melihat saldo token tersedia.
- Melihat token yang sedang di-reserve.
- Melihat riwayat penggunaan token.
- Melihat token hasil refund.
- Melihat sumber token masuk.
- Melihat referensi job terkait.

Setiap perubahan token oleh admin wajib memiliki alasan.

### Acceptance Criteria

- Admin dapat melihat saldo semua user.
- Admin dapat menambahkan atau mengurangi token user.
- Setiap perubahan token admin memiliki audit log.
- User dapat melihat saldo token.
- User dapat melihat riwayat token masuk dan keluar.
- User hanya dapat melihat riwayat miliknya sendiri.
- Riwayat menampilkan saldo sebelum dan sesudah.
- Riwayat menampilkan jenis transaksi token.
- Riwayat dapat difilter berdasarkan tanggal dan jenis aktivitas.
- Koreksi token oleh admin tidak dapat dilakukan tanpa alasan.
- Semua perubahan token tersimpan di token ledger.

### Struktur Teknis yang Disarankan

Endpoint admin:

- `GET /admin/token-users`
- `GET /admin/token-users/:userId`
- `POST /admin/token-users/:userId/adjustment`
- `GET /admin/token-ledgers`

Endpoint user:

- `GET /user/token-wallet`
- `GET /user/token-history`
- `GET /user/token-reservations`

Data token ledger minimal:

- `id`
- `user_id`
- `type`
- `amount`
- `balance_before`
- `balance_after`
- `reference_type`
- `reference_id`
- `description`
- `created_by`
- `created_at`

Permission admin yang disarankan:

- `token.view`
- `token.adjust`
- `token.history.view`

---

# Phase 3 — Package dan Menu Top Up

## Tugas

Tambahkan menu Top Up pada halaman user.

Admin dapat membuat dan mengubah package token.

Data package minimal:

- Nama package.
- Deskripsi.
- Harga.
- Jumlah token.
- Daftar fitur atau benefit.
- Status aktif atau nonaktif.
- Urutan tampilan.
- Currency.
- Masa berlaku token jika diperlukan.

User dapat melihat package yang aktif.

Setiap package harus menjelaskan:

- Jumlah token yang diperoleh.
- Fitur yang dapat digunakan.
- Estimasi penggunaan token.
- Benefit tambahan jika tersedia.

Saat transaksi dibuat, sistem harus menyimpan snapshot package agar perubahan package tidak mengubah transaksi lama.

### Acceptance Criteria

- Admin dapat membuat package.
- Admin dapat mengubah package.
- Admin dapat mengaktifkan atau menonaktifkan package.
- User hanya dapat melihat package aktif.
- User dapat melihat harga dan jumlah token.
- User dapat melihat daftar benefit package.
- Package yang sudah digunakan transaksi tidak boleh dihapus permanen.
- Transaksi lama tetap menyimpan nama, harga, token, dan benefit saat pembelian.
- Harga dan jumlah token tidak boleh dikirim langsung dari frontend sebagai sumber utama.

### Struktur Teknis yang Disarankan

Buat modul:

- `PackageManagement`
- `PackageBenefit`
- `TopUpCatalog`

Tabel:

- `token_packages`
- `token_package_benefits`

Data package:

- `id`
- `name`
- `description`
- `price`
- `currency`
- `token_amount`
- `is_active`
- `display_order`
- `token_expiration_days`
- `created_at`
- `updated_at`

Endpoint admin:

- `POST /admin/token-packages`
- `PUT /admin/token-packages/:id`
- `GET /admin/token-packages`
- `PATCH /admin/token-packages/:id/status`

Endpoint user:

- `GET /token-packages`
- `GET /token-packages/:id`

---

# Phase 4 — Payment Gateway Driver

## Tugas

Buat payment gateway menggunakan pola driver atau adapter agar sistem dapat menggunakan lebih dari satu payment gateway.

Admin dapat:

- Menambahkan konfigurasi payment gateway.
- Mengatur credentials.
- Mengaktifkan atau menonaktifkan provider.
- Memilih provider default.
- Mengubah provider tanpa mengubah business logic transaksi.
- Mengatur metode pembayaran yang tersedia.

Credentials payment gateway harus:

- Disimpan dalam keadaan terenkripsi.
- Tidak ditampilkan secara penuh.
- Tidak dimasukkan ke log.
- Hanya dapat diubah oleh admin dengan permission tertentu.

### Acceptance Criteria

- Sistem dapat mendukung lebih dari satu payment gateway.
- Admin dapat memilih payment gateway aktif.
- Admin dapat mengganti provider dari dashboard.
- Business logic transaksi tidak bergantung langsung pada satu provider.
- Credentials tersimpan terenkripsi.
- Secret key tidak dikirim ke frontend.
- Sistem dapat memverifikasi webhook setiap provider.
- Setiap provider memiliki konfigurasi timeout dan status aktif.
- Sistem tetap berjalan jika salah satu provider dinonaktifkan.

### Struktur Teknis yang Disarankan

Interface payment gateway:

```text
PaymentGatewayDriver
- CreatePayment()
- GetPaymentStatus()
- CancelPayment()
- ExpirePayment()
- VerifyWebhookSignature()
- ParseWebhook()
- RefundPayment()
- HealthCheck()
```

Implementasi driver:

```text
PaymentGatewayDriver
├── XenditDriver
├── MidtransDriver
├── DokuDriver
└── ManualPaymentDriver
```

Buat modul:

- `PaymentGatewayRegistry`
- `PaymentGatewayFactory`
- `PaymentGatewayConfig`
- `PaymentCredentialEncryption`

Tabel:

- `payment_gateways`
- `payment_gateway_credentials`
- `payment_gateway_methods`

---

# Phase 5 — Transaksi Pembelian Package

## Tugas

Buat modul transaksi agar user dapat membeli package token.

Alur transaksi:

1. User memilih package.
2. Backend mengambil package dari database.
3. Backend menghitung harga dan token.
4. Backend membuat transaksi.
5. Backend menyimpan snapshot package.
6. Backend membuat invoice ke payment gateway.
7. User menerima link atau instruksi pembayaran.
8. Webhook diterima dan diverifikasi.
9. Jika pembayaran berhasil, transaksi menjadi `paid`.
10. Token ditambahkan ke wallet user.
11. Token hanya boleh ditambahkan satu kali.

Status transaksi:

- `pending`
- `paid`
- `expired`
- `failed`
- `cancelled`
- `refunded`

### Acceptance Criteria

- User dapat membeli package aktif.
- Transaksi memiliki nomor unik.
- Harga diambil dari database, bukan frontend.
- Transaksi menyimpan snapshot package.
- Invoice dapat dibuat melalui payment gateway aktif.
- Token hanya ditambahkan setelah pembayaran valid.
- Redirect pembayaran tidak dapat langsung mengubah status menjadi paid.
- Webhook yang sama tidak menambah token dua kali.
- Satu transaksi hanya dapat memiliki satu proses credit token.
- User hanya dapat melihat transaksinya sendiri.
- Admin dapat melihat semua transaksi.
- Semua perubahan status memiliki audit log.

### Struktur Teknis yang Disarankan

Buat modul:

- `Transaction`
- `PaymentInvoice`
- `PaymentWebhook`
- `TokenPurchase`
- `TransactionAudit`

Tabel:

- `transactions`
- `transaction_items`
- `payment_invoices`
- `payment_webhook_logs`
- `transaction_status_histories`

Gunakan field:

- `transaction_number`
- `user_id`
- `package_id`
- `package_snapshot`
- `amount`
- `currency`
- `token_amount`
- `payment_gateway_id`
- `payment_reference`
- `status`
- `expires_at`
- `paid_at`
- `created_at`

Gunakan unique constraint untuk:

- `transaction_number`
- `payment_reference`
- `webhook_event_id`
- `token_ledger_reference`

---

# Phase 6 — Payment Expiration dan Scheduler

## Tugas

Admin dapat mengatur batas waktu pembayaran, misalnya:

- 15 menit.
- 30 menit.
- 1 jam.
- 24 jam.

Setiap transaksi harus memiliki `expires_at`.

Buat scheduler atau event handler untuk memeriksa transaksi pending yang sudah melewati waktu pembayaran.

Jika transaksi sudah kedaluwarsa:

- Ubah status menjadi `expired`.
- Batalkan invoice melalui payment gateway jika didukung.
- Kirim notifikasi kepada user.
- Simpan perubahan status ke audit log.

Webhook yang datang setelah transaksi expired harus melalui proses rekonsiliasi dan tidak boleh langsung menambahkan token tanpa validasi.

### Acceptance Criteria

- Admin dapat mengatur durasi pembayaran.
- Setiap transaksi pending memiliki waktu kedaluwarsa.
- Transaksi otomatis menjadi expired setelah batas waktu.
- Scheduler aman dijalankan lebih dari satu instance.
- Proses expiration tidak berjalan dua kali.
- User menerima notifikasi ketika pembayaran expired.
- Transaksi paid tidak dapat diubah menjadi expired.
- Late webhook ditangani secara aman.
- Semua proses expiration memiliki log.

### Struktur Teknis yang Disarankan

Buat scheduler:

```text
payment-expiration-scheduler
```

Flow:

```text
Find pending transactions
→ Lock transaction
→ Check expires_at
→ Check latest payment status
→ Mark expired
→ Cancel payment if supported
→ Publish notification
```

Gunakan:

- Distributed lock.
- Database row locking.
- Idempotency key.
- Batch processing.
- Retry mechanism.
- Dead-letter queue jika menggunakan message broker.

Event:

- `payment.expired`
- `payment.expiration.failed`
- `payment.late_success`
- `payment.reconciliation.required`

---

# Phase 7 — Riwayat Transaksi dan Notifikasi

## Tugas

Tambahkan halaman riwayat transaksi user.

Informasi yang ditampilkan:

- Nomor transaksi.
- Nama package.
- Harga.
- Jumlah token.
- Metode pembayaran.
- Status.
- Tanggal transaksi.
- Waktu kedaluwarsa.
- Waktu pembayaran.
- Link atau instruksi pembayaran.

Tambahkan halaman transaksi admin.

Admin dapat:

- Melihat seluruh transaksi.
- Melakukan filter.
- Melihat detail transaksi.
- Melihat payment reference.
- Melihat status history.
- Melihat webhook yang sudah disanitasi.
- Melakukan rekonsiliasi sesuai permission.

Buat notifikasi kepada user untuk:

- Invoice dibuat.
- Pembayaran berhasil.
- Pembayaran gagal.
- Pembayaran expired.
- Token berhasil ditambahkan.

Buat notifikasi kepada admin untuk:

- Ada pembelian baru.
- User berhasil membayar.
- Webhook gagal diverifikasi.
- Terjadi payment mismatch.
- Transaksi membutuhkan rekonsiliasi.

### Acceptance Criteria

- User dapat melihat riwayat transaksi.
- User hanya dapat melihat transaksi miliknya.
- Admin dapat melihat seluruh transaksi.
- Admin dapat melakukan filter berdasarkan status, user, provider, package, dan tanggal.
- User menerima notifikasi invoice.
- User menerima notifikasi pembayaran berhasil.
- Admin menerima alert pembelian baru.
- Admin menerima notifikasi pembayaran berhasil.
- Notifikasi tidak dikirim dua kali untuk event yang sama.
- Webhook sensitif tidak ditampilkan secara penuh.

### Struktur Teknis yang Disarankan

Buat modul:

- `Notification`
- `UserTransactionHistory`
- `AdminTransactionDashboard`
- `PaymentReconciliation`

Tabel:

- `notifications`
- `notification_deliveries`
- `payment_reconciliations`

Event:

- `transaction.created`
- `payment.pending`
- `payment.paid`
- `payment.failed`
- `payment.expired`
- `token.purchase.credited`
- `admin.purchase.alert`

---

# Phase 8 — Data Retention dan Penghapusan File

## Tugas

Buat scheduler untuk menghapus data Auto Clipping dan TTS yang sudah berumur lebih dari 1 bulan.

Data yang dihapus:

- Riwayat job Auto Clipping.
- Riwayat job Generate TTS.
- Hasil clip.
- Hasil audio TTS.
- File temporary.
- Thumbnail terkait.
- Subtitle atau output pendukung.
- File terkait di MinIO.

Scheduler dijalankan setiap hari pukul 23:00.

Proses penghapusan harus dilakukan secara bertahap:

1. Cari data yang sudah melewati retention period.
2. Tandai data sebagai pending deletion.
3. Hapus file dari MinIO.
4. Hapus atau anonymize data database.
5. Simpan audit log.
6. Retry jika penghapusan file gagal.

Tambahkan informasi di halaman user:

> Riwayat job serta file hasil Auto Clipping dan TTS disimpan selama 30 hari. Setelah melewati periode tersebut, data dan file akan dihapus secara otomatis.

dan 2 hari sebelum di hapus harus ada notification ke user terlebih dahulu. Suapay user notice

### Acceptance Criteria

- Scheduler berjalan otomatis setiap hari.
- Data lebih lama dari 30 hari dapat dihapus.
- File MinIO terkait ikut dihapus.
- Data yang belum berumur 30 hari tidak terhapus.
- File gagal dihapus akan masuk retry.
- Proses cleanup aman dijalankan ulang.
- Job aktif tidak boleh terhapus.
- File yang masih digunakan proses lain tidak boleh terhapus.
- Setiap penghapusan memiliki audit log.
- User dapat melihat informasi masa penyimpanan 30 hari.
- Admin dapat melihat hasil scheduler cleanup.
- Retention period dapat dibuat configurable.

### Struktur Teknis yang Disarankan

Buat modul:

- `DataRetention`
- `StorageCleanup`
- `MinioCleanup`
- `CleanupAudit`
- `CleanupRetry`

Tabel:

- `retention_policies`
- `deletion_jobs`
- `deletion_job_items`
- `storage_cleanup_logs`

Status deletion:

- `pending`
- `processing`
- `completed`
- `partial_failed`
- `failed`
- `retrying`

Scheduler:

```text
daily-data-retention-cleanup
```

Flow:

```text
Find expired jobs
→ Exclude active jobs
→ Mark pending deletion
→ Delete MinIO objects
→ Delete related database records
→ Save cleanup result
→ Retry failed objects
```

---

# Phase 9 — Security Hardening dan Rekonsiliasi

## Tugas

Lakukan security hardening untuk seluruh proses token dan transaksi.

Keamanan wajib:

- Jangan percaya harga, token, atau status dari frontend.
- Validasi ulang package dari database.
- Verifikasi signature webhook.
- Validasi merchant ID, amount, currency, dan payment reference.
- Gunakan idempotency key.
- Cegah webhook replay attack.
- Gunakan database transaction.
- Gunakan row locking saat mengubah saldo.
- Gunakan unique constraint untuk mencegah duplicate credit.
- Enkripsi payment credentials.
- Terapkan RBAC admin.
- Terapkan rate limiting.
- Jangan menyimpan data kartu.
- Jangan mencatat secret ke log.
- Sanitasi webhook payload.
- Gunakan HTTPS.
- Buat proses rekonsiliasi pembayaran.
- Simpan audit log untuk aktivitas sensitif.

### Acceptance Criteria

- Frontend tidak dapat memanipulasi harga package.
- Frontend tidak dapat menentukan jumlah token.
- Webhook tanpa signature valid ditolak.
- Webhook replay tidak diproses kembali.
- Duplicate webhook tidak menyebabkan duplicate token.
- Payment redirect tidak dapat mengubah transaksi menjadi paid.
- Credentials payment gateway terenkripsi.
- Admin tanpa permission tidak dapat mengubah credentials.
- User tidak dapat melihat transaksi user lain.
- Semua perubahan transaksi memiliki audit log.
- Semua perubahan saldo memiliki ledger.
- Sistem dapat mendeteksi payment mismatch.
- Sistem memiliki proses rekonsiliasi transaksi.

### Struktur Teknis yang Disarankan

Security components:

- `WebhookSignatureVerifier`
- `IdempotencyService`
- `CredentialEncryptionService`
- `TransactionAuthorization`
- `PaymentReconciliationService`
- `AuditLogService`

Permission yang disarankan:

- `payment_gateway.view`
- `payment_gateway.manage`
- `transaction.view`
- `transaction.reconcile`
- `package.view`
- `package.manage`
- `token.view`
- `token.adjust`
- `retention.view`
- `retention.manage`

Gunakan immutable ledger untuk token dan append-only status history untuk transaksi.

Tambahkan fase khusus untuk penyesuaian halaman publik agar sistem token, masa penyimpanan file, package, dan pembayaran mudah dipahami calon user.

# Phase 10 — Penyesuaian Halaman Publik dan Edukasi User

## Tugas

Sesuaikan halaman publik agar calon user memahami cara kerja platform sebelum mendaftar atau membeli package.

Informasi harus menggunakan bahasa sederhana, tidak terlalu teknis, dan mudah dipahami oleh user baru.

### 1. Penyesuaian Landing Page

Tambahkan penjelasan singkat mengenai alur penggunaan platform:

1. Upload video atau masukkan link YouTube.
2. Pilih mode Auto Clipping atau Generate TTS.
3. Sistem menampilkan estimasi token yang diperlukan.
4. User menjalankan proses.
5. Token hanya digunakan ketika proses dijalankan.
6. Hasil dapat diunduh dan disimpan selama 30 hari.

Tambahkan section **Cara Kerja Token** yang menjelaskan:

- Setiap fitur membutuhkan sejumlah token.
- Biaya token berbeda berdasarkan fitur dan mode yang dipilih.
- Estimasi token ditampilkan sebelum proses dimulai.
- Regenerate Clip juga menggunakan token.
- Jika proses gagal karena kesalahan sistem, token akan dikembalikan.
- Video YouTube dengan durasi lebih dari 59 menit dapat dikenakan token tambahan.
- User dapat membeli token melalui package Top Up.

Tambahkan section **Pilih Package Sesuai Kebutuhan** yang menampilkan:

- Nama package.
- Harga.
- Jumlah token.
- Fitur yang tersedia.
- Perkiraan jumlah proses yang dapat dilakukan.
- Tombol daftar atau beli package.

Perkiraan penggunaan harus diberi keterangan bahwa jumlah sebenarnya bergantung pada mode dan konfigurasi yang dipilih.

### 2. Informasi Masa Penyimpanan File

Tampilkan informasi masa penyimpanan pada:

- Landing page.
- FAQ.
- Halaman upload.
- Halaman hasil clipping.
- Halaman hasil TTS.
- Halaman riwayat job.

Gunakan informasi berikut:

> File hasil Auto Clipping, TTS, dan riwayat job disimpan selama 30 hari sejak proses selesai. Setelah periode tersebut, file dan riwayat terkait akan dihapus secara otomatis dan tidak dapat dipulihkan. Pastikan Anda mengunduh hasil sebelum masa penyimpanan berakhir.

Pada halaman hasil dan riwayat, tampilkan:

- Tanggal file dibuat.
- Tanggal file akan dihapus.
- Sisa hari penyimpanan.
- Tombol download.
- Peringatan ketika masa penyimpanan hampir habis.

Contoh peringatan:

> File ini akan dihapus otomatis dalam 3 hari. Unduh sekarang agar hasil tidak hilang.

### 3. Informasi Sebelum Menjalankan Proses

Sebelum user menekan tombol Generate, tampilkan ringkasan:

- Fitur yang digunakan.
- Mode yang dipilih.
- Estimasi biaya token.
- Biaya tambahan jika ada.
- Saldo token saat ini.
- Perkiraan saldo setelah proses.
- Informasi bahwa token akan dikembalikan jika proses gagal karena kesalahan sistem.

Contoh:

```text
Ringkasan Penggunaan

Mode: Smart Speaker Adaptif
Biaya proses: 20 token
Tambahan video lebih dari 59 menit: 5 token
Total: 25 token
Saldo Anda: 100 token
Sisa setelah proses: 75 token
```

Gunakan tombol:

- `Mulai Proses — 25 Token`
- `Batal`

Jika saldo tidak cukup, tampilkan:

> Token Anda tidak mencukupi untuk menjalankan proses ini. Silakan pilih mode lain atau lakukan Top Up.

### 4. Penyesuaian Halaman Pricing

Tambahkan halaman pricing yang menjelaskan:

- Token yang diperoleh dari setiap package.
- Fitur yang dapat digunakan.
- Perbedaan antar-package.
- Estimasi penggunaan token.
- Metode pembayaran yang tersedia.
- Masa berlaku token jika diterapkan.
- Ketentuan refund token.
- Masa penyimpanan hasil selama 30 hari.

Jangan menjanjikan jumlah clip pasti jika biaya bergantung pada mode yang dipilih.

Gunakan format estimasi:

> Hingga sekitar 20 proses Crop Center, tergantung durasi video dan konfigurasi yang digunakan.

### 5. Penyesuaian Halaman Checkout

Sebelum pembayaran, tampilkan:

- Package yang dipilih.
- Jumlah token.
- Harga.
- Pajak atau biaya tambahan jika ada.
- Total pembayaran.
- Payment gateway atau metode pembayaran.
- Batas waktu pembayaran.
- Informasi bahwa token masuk setelah pembayaran berhasil diverifikasi.

Contoh informasi:

> Token akan otomatis ditambahkan ke akun setelah pembayaran berhasil dikonfirmasi oleh penyedia pembayaran.

Tampilkan countdown waktu pembayaran untuk transaksi pending.

### 6. Penyesuaian FAQ

Tambahkan FAQ berikut.

#### Apa itu token?

Token adalah saldo yang digunakan untuk menjalankan fitur Auto Clipping, Regenerate Clip, dan Generate TTS.

#### Berapa token yang dibutuhkan untuk membuat clip?

Jumlah token bergantung pada mode crop yang dipilih. Estimasi biaya akan ditampilkan sebelum proses dimulai.

#### Apakah Regenerate Clip menggunakan token?

Ya. Setiap proses Regenerate Clip dianggap sebagai proses baru dan akan menggunakan token sesuai mode yang dipilih.

#### Mengapa video panjang membutuhkan token tambahan?

Video YouTube dengan durasi lebih dari 59 menit membutuhkan pemrosesan lebih besar sehingga dapat dikenakan token tambahan. Jumlah tambahannya akan ditampilkan sebelum proses dimulai.

#### Apakah token tetap terpotong jika proses gagal?

Jika proses gagal karena kesalahan sistem, token yang telah di-reserve akan dikembalikan secara otomatis. Token tidak dikembalikan jika kegagalan disebabkan oleh input yang tidak valid atau tindakan user sesuai kebijakan yang berlaku.

#### Bagaimana cara mengetahui biaya sebelum memulai?

Sistem akan menampilkan rincian mode, biaya dasar, biaya tambahan, total token, serta sisa saldo sebelum Anda mengonfirmasi proses.

#### Bagaimana cara mendapatkan token?

Token dapat diperoleh dengan membeli package melalui menu Top Up. Setiap package memiliki harga, jumlah token, dan benefit yang berbeda.

#### Kapan token dari pembelian masuk?

Token akan masuk secara otomatis setelah pembayaran berhasil diverifikasi oleh payment gateway.

#### Apa yang terjadi jika pembayaran tidak diselesaikan?

Transaksi akan otomatis kedaluwarsa setelah melewati batas waktu pembayaran. User dapat membuat transaksi baru untuk melanjutkan pembelian.

#### Bisakah saya mengganti metode pembayaran?

Selama transaksi belum dibayar, user dapat membatalkan transaksi atau menunggu hingga kedaluwarsa, kemudian membuat transaksi baru menggunakan metode pembayaran lain yang tersedia.

#### Berapa lama hasil Auto Clipping dan TTS disimpan?

File hasil dan riwayat job disimpan selama 30 hari sejak proses selesai.

#### Apa yang terjadi setelah 30 hari?

File, clip, audio TTS, subtitle, thumbnail, dan riwayat terkait akan dihapus secara otomatis dari sistem dan tidak dapat dipulihkan.

#### Apakah file yang sudah dihapus dapat dikembalikan?

Tidak. User harus mengunduh hasil sebelum tanggal penghapusan.

#### Apakah saya akan mendapat pengingat sebelum file dihapus?

Sistem akan menampilkan informasi tanggal penghapusan dan peringatan pada halaman riwayat atau hasil ketika masa penyimpanan hampir habis.

#### Apakah pembayaran di platform ini aman?

Pembayaran diproses melalui payment gateway yang aktif. Sistem tidak menyimpan data kartu dan status pembayaran hanya diperbarui setelah mendapat konfirmasi yang valid dari penyedia pembayaran.

### 7. Notifikasi dan Microcopy

Gunakan pesan yang jelas pada setiap kondisi.

#### Token berhasil digunakan

> Proses berhasil dimulai. Sebanyak 20 token telah digunakan.

#### Token sedang di-reserve

> Sebanyak 20 token sedang diamankan untuk proses ini. Token akan dikembalikan jika proses gagal karena kesalahan sistem.

#### Token dikembalikan

> Proses gagal karena kendala sistem. Sebanyak 20 token telah dikembalikan ke saldo Anda.

#### Pembayaran berhasil

> Pembayaran berhasil. Sebanyak 500 token telah ditambahkan ke akun Anda.

#### Pembayaran menunggu

> Menunggu pembayaran. Selesaikan pembayaran sebelum 19 Juli 2026 pukul 22.00 WIB.

#### Pembayaran kedaluwarsa

> Waktu pembayaran telah berakhir. Transaksi ini tidak dapat dilanjutkan. Silakan buat transaksi baru.

#### File hampir dihapus

> Hasil ini akan dihapus otomatis dalam 3 hari. Unduh file sekarang agar tidak hilang.

#### File sudah dihapus

> File ini telah dihapus karena melewati masa penyimpanan 30 hari.

### 8. Penempatan Informasi

Informasi token dan masa penyimpanan harus tersedia pada:

- Landing page.
- Halaman pricing.
- FAQ.
- Form Auto Clipping.
- Form Generate TTS.
- Modal konfirmasi generate.
- Halaman Top Up.
- Halaman checkout.
- Halaman transaksi.
- Halaman hasil.
- Halaman riwayat job.
- Dashboard user.

Hindari hanya menampilkan informasi penting di Terms and Conditions.

## Acceptance Criteria

- Calon user dapat memahami fungsi token dari landing page.
- User dapat mengetahui estimasi biaya sebelum menjalankan proses.
- User dapat melihat biaya tambahan sebelum mengonfirmasi proses.
- User memahami bahwa Regenerate Clip menggunakan token.
- User memahami kondisi pengembalian token.
- User dapat melihat package, harga, jumlah token, dan benefit.
- User mengetahui token hanya masuk setelah pembayaran berhasil diverifikasi.
- User dapat melihat batas waktu pembayaran.
- Informasi penyimpanan selama 30 hari tampil pada halaman yang relevan.
- Halaman hasil menampilkan tanggal penghapusan file.
- User mendapat peringatan sebelum file mendekati tanggal penghapusan.
- FAQ menjelaskan token, pembayaran, refund token, dan penghapusan file.
- Semua informasi menggunakan bahasa yang mudah dipahami dan konsisten.
- Tampilan responsif pada desktop dan mobile.
- Informasi biaya berasal dari konfigurasi backend, bukan nilai statis frontend.
- Countdown dan tanggal kedaluwarsa menggunakan data dari server.

## Struktur Teknis yang Disarankan

Buat komponen frontend reusable:

- `TokenBalanceBadge`
- `TokenCostEstimate`
- `TokenUsageConfirmation`
- `InsufficientTokenAlert`
- `PackageCard`
- `PaymentCountdown`
- `TransactionStatusBadge`
- `RetentionNotice`
- `FileExpirationBadge`
- `DownloadBeforeDeletionAlert`
- `FAQAccordion`

Buat endpoint publik:

- `GET /public/token-pricing`
- `GET /public/token-packages`
- `GET /public/payment-methods`
- `GET /public/platform-policies`

Buat endpoint user:

- `GET /user/token-balance`
- `POST /user/token-cost-estimation`
- `GET /user/jobs/:id/retention`
- `GET /user/transactions/:id`

Konfigurasi konten publik yang disarankan:

```text
platform_policy
- token_refund_description
- file_retention_days
- long_video_duration_threshold
- payment_timeout_description
- support_contact
```

Frontend tidak boleh menghitung biaya akhir sendiri. Frontend mengirim konfigurasi pilihan user ke backend, lalu backend mengembalikan rincian estimasi biaya.

Contoh response estimasi:

```json
{
  "feature": "auto_clipping",
  "mode": "smart_speaker",
  "base_token": 20,
  "additional_token": 5,
  "total_token": 25,
  "current_balance": 100,
  "balance_after": 75,
  "is_sufficient": true
}
```

Gunakan content management sederhana agar admin dapat memperbarui FAQ, informasi pricing, dan kebijakan penyimpanan tanpa melakukan deployment ulang.

# Phase 11 — Dukungan Auto Clipping Bahasa Inggris dan Multi-Language Dashboard

## Tugas

Tambahkan dukungan bahasa Inggris pada fitur Auto Clipping dan seluruh halaman dashboard user.

Sistem minimal mendukung:

- Bahasa Indonesia (`id`).
- Bahasa Inggris (`en`).

Dukungan bahasa dibagi menjadi dua bagian:

1. Bahasa konten video yang diproses.
2. Bahasa tampilan aplikasi atau dashboard.

---

## 1. Bahasa Konten Auto Clipping

Tambahkan pilihan bahasa konten pada form Auto Clipping:

- Auto Detect.
- Bahasa Indonesia.
- English.

Pilihan bahasa digunakan pada proses:

- Transcription.
- Pemilihan bagian video terbaik.
- Analisis hook.
- Pembuatan judul clip.
- Pembuatan subtitle.
- Pembuatan caption atau deskripsi.
- Deteksi filler words.
- Penilaian kualitas clip.
- Pembuatan metadata hasil clip.

### Auto Detect

Jika user memilih `Auto Detect`, sistem harus mendeteksi bahasa dominan pada video.

Setelah bahasa terdeteksi, sistem menggunakan prompt dan aturan clipping sesuai bahasa tersebut.

Contoh hasil deteksi:

```text
Detected language: English
Confidence: 96%
```

Jika tingkat keyakinan deteksi bahasa rendah, sistem dapat:

- Menggunakan bahasa yang dipilih user sebagai fallback.
- Menampilkan peringatan kepada user.
- Menggunakan bahasa dominan dari transcript.

### Auto Clipping Bahasa Inggris

Untuk video berbahasa Inggris, sistem harus memilih potongan yang:

- Memiliki hook kuat dalam 1–3 detik pertama.
- Mudah dipahami tanpa konteks video panjang.
- Menggunakan kalimat yang natural dan jelas.
- Memiliki konflik, insight, curiosity gap, atau payoff.
- Memiliki ending yang selesai dan tidak terpotong.
- Cocok untuk TikTok, Reels, dan YouTube Shorts.
- Menghindari filler, pengulangan, jeda kosong, dan pembukaan yang terlalu panjang.

Prompt analisis bahasa Inggris harus menggunakan bahasa Inggris agar hasil judul, subtitle, dan metadata lebih natural.

### Output Bahasa

Tambahkan pilihan bahasa output:

- Same as Source.
- Bahasa Indonesia.
- English.

Contoh penggunaan:

- Video Inggris → subtitle Inggris.
- Video Inggris → subtitle Indonesia.
- Video Indonesia → subtitle Inggris.
- Video Indonesia → subtitle Indonesia.

Jika bahasa output berbeda dari bahasa sumber, sistem harus melakukan translation setelah transcription dan sebelum subtitle final dibuat.

Tambahkan opsi output berikut:

- Bahasa judul clip.
- Bahasa subtitle.
- Bahasa caption atau deskripsi.
- Bahasa keyword atau hashtag.

Secara default, seluruh output menggunakan `Same as Source`.

---

## 2. Subtitle Bahasa Inggris

Pastikan subtitle bahasa Inggris mendukung:

- Word-level timestamps.
- Highlight per kata.
- Kapitalisasi yang benar.
- Tanda baca yang natural.
- Contraction seperti `don't`, `you're`, dan `it's`.
- Nama orang, tempat, brand, dan istilah teknis.
- Pengaturan maksimal karakter per baris.
- Pemotongan subtitle berdasarkan frasa, bukan sekadar jumlah karakter.

Subtitle tidak boleh memotong frasa secara tidak natural.

Contoh yang harus dihindari:

```text
This is the reason
why your business
```

Contoh yang lebih baik:

```text
This is the reason why
your business keeps failing.
```

Tambahkan glossary atau custom vocabulary agar user dapat memasukkan:

- Nama orang.
- Nama perusahaan.
- Nama produk.
- Istilah teknis.
- Singkatan.
- Kata yang sering salah ditranskripsikan.

---

## 3. Language Switcher Dashboard

Tambahkan language switcher pada dashboard user.

Lokasi yang disarankan:

- Header dashboard.
- User profile menu.
- Halaman Settings.

Pilihan:

- 🇮🇩 Bahasa Indonesia
- 🇬🇧 English

Ketika user mengganti bahasa, seluruh tampilan dashboard harus berubah tanpa perlu login ulang.

Bagian dashboard yang harus mendukung terjemahan:

- Sidebar.
- Dashboard overview.
- Auto Clipping.
- Generate TTS.
- Token balance.
- Token history.
- Top Up.
- Package.
- Checkout.
- Transaction history.
- Notifications.
- Job history.
- Result page.
- Settings.
- FAQ.
- Error message.
- Empty state.
- Confirmation modal.
- Retention notice.
- Payment status.
- Email dan in-app notification.

Pilihan bahasa harus disimpan pada profil user agar tetap digunakan setelah logout dan login kembali.

Untuk user yang belum login, simpan pilihan bahasa di cookie atau local storage.

---

## 4. Bahasa Default

Gunakan aturan bahasa default berikut:

1. Gunakan bahasa yang tersimpan pada profil user.
2. Jika belum tersedia, gunakan pilihan dari cookie atau local storage.
3. Jika belum tersedia, gunakan bahasa browser.
4. Jika bahasa browser tidak didukung, gunakan bahasa Inggris atau bahasa default aplikasi.

Bahasa interface tidak harus sama dengan bahasa video.

Contoh:

- Dashboard menggunakan Bahasa Indonesia.
- Video yang diproses menggunakan bahasa Inggris.
- Subtitle output menggunakan bahasa Inggris.

Ketiga pengaturan tersebut harus disimpan secara terpisah.

---

## 5. Penyesuaian Halaman Publik

Tambahkan language switcher pada halaman publik:

- Landing page.
- Pricing.
- FAQ.
- Login.
- Register.
- Terms and Conditions.
- Privacy Policy.
- Contact atau Support.

Konten publik harus tersedia dalam Bahasa Indonesia dan bahasa Inggris.

Contoh FAQ tambahan:

### Apakah Auto Clipping mendukung video bahasa Inggris?

Ya. Auto Clipping mendukung video berbahasa Indonesia dan Inggris. Anda dapat memilih bahasa secara manual atau menggunakan fitur Auto Detect.

### Can I process English videos?

Yes. Auto Clipping supports both Indonesian and English videos. You can select the language manually or let the system detect it automatically.

### Apakah subtitle dapat diterjemahkan?

Ya. Anda dapat menggunakan bahasa yang sama dengan video atau menerjemahkan subtitle ke Bahasa Indonesia atau Inggris.

### Can I change the dashboard language?

Yes. You can switch the dashboard between Indonesian and English from the header or account settings.

### Apakah bahasa dashboard memengaruhi hasil video?

Tidak. Bahasa dashboard, bahasa sumber video, dan bahasa output dapat diatur secara terpisah.

---

## 6. Penyesuaian Form Auto Clipping

Tambahkan field berikut:

```text
Source Language
- Auto Detect
- Indonesian
- English

Output Language
- Same as Source
- Indonesian
- English
```

Tambahkan opsi lanjutan:

```text
Clip Title Language
Subtitle Language
Caption Language
Custom Vocabulary
```

Tampilkan informasi:

> Pemilihan bahasa yang tepat membantu sistem menghasilkan transcript, subtitle, judul, dan potongan video yang lebih akurat.

Versi Inggris:

> Selecting the correct language helps the system generate more accurate transcripts, subtitles, titles, and video clips.

---

## 7. Penyesuaian Token

Admin dapat menentukan apakah proses tambahan berikut dikenakan token:

- Language detection.
- Translation.
- English transcription provider.
- Indonesian transcription provider.
- Generation of translated subtitles.

Jika translation membutuhkan biaya tambahan, sistem harus menampilkannya pada estimasi token sebelum proses dimulai.

Contoh:

```text
Auto Clipping: 20 tokens
English transcription: Included
Translate subtitles to Indonesian: 5 tokens
Total: 25 tokens
```

Biaya tambahan harus berasal dari konfigurasi backend dan tidak boleh dihitung statis oleh frontend.

---

## Acceptance Criteria

- User dapat memproses video berbahasa Inggris.
- User dapat memilih Bahasa Indonesia, English, atau Auto Detect.
- Sistem dapat mendeteksi bahasa dominan video.
- Sistem menggunakan prompt clipping sesuai bahasa sumber.
- Judul clip bahasa Inggris terdengar natural dan tidak seperti hasil terjemahan literal.
- Subtitle bahasa Inggris memiliki punctuation dan capitalization yang benar.
- User dapat memilih bahasa subtitle dan output.
- Sistem dapat menerjemahkan subtitle Indonesia ke Inggris dan sebaliknya.
- Bahasa dashboard dapat diganti antara Indonesia dan Inggris.
- Pergantian bahasa tidak membutuhkan login ulang.
- Pilihan bahasa tersimpan pada profil user.
- User yang belum login tetap memiliki pilihan bahasa melalui cookie atau local storage.
- Seluruh menu, modal, validasi, notifikasi, dan error message tersedia dalam dua bahasa.
- Bahasa dashboard tidak mengubah bahasa sumber atau output video secara otomatis.
- Landing page, pricing, dan FAQ tersedia dalam dua bahasa.
- Estimasi biaya translation ditampilkan sebelum proses dimulai.
- Backend tetap menjadi sumber utama perhitungan biaya token.
- Fallback translation tersedia jika translation key tidak ditemukan.
- Tidak ada teks hardcoded pada komponen utama dashboard.

---

## Struktur Teknis yang Disarankan

### Modul Backend

Buat atau tambahkan modul:

- `LanguageDetectionService`
- `TranscriptionLanguageResolver`
- `ClipPromptResolver`
- `SubtitleTranslationService`
- `OutputLanguageService`
- `UserLanguagePreference`

### Frontend Internationalization

Gunakan struktur translation:

```text
locales/
├── id/
│   ├── common.json
│   ├── dashboard.json
│   ├── clipping.json
│   ├── tts.json
│   ├── token.json
│   ├── payment.json
│   ├── notification.json
│   └── faq.json
└── en/
    ├── common.json
    ├── dashboard.json
    ├── clipping.json
    ├── tts.json
    ├── token.json
    ├── payment.json
    ├── notification.json
    └── faq.json
```

Komponen yang disarankan:

- `LanguageSwitcher`
- `SourceLanguageSelector`
- `OutputLanguageSelector`
- `LanguageDetectionBadge`
- `TranslationCostEstimate`
- `CustomVocabularyInput`

### Data User Preference

Tambahkan field pada user settings:

```text
interface_language
default_source_language
default_output_language
default_subtitle_language
```

Contoh nilai:

```text
interface_language: en
default_source_language: auto
default_output_language: same_as_source
default_subtitle_language: same_as_source
```

### Data Job Auto Clipping

Tambahkan field:

```text
source_language
detected_language
language_detection_confidence
output_language
subtitle_language
title_language
caption_language
translation_enabled
```

### Prompt Resolver

Gunakan prompt berdasarkan bahasa:

```text
prompts/
├── clipping/
│   ├── id.txt
│   └── en.txt
├── title/
│   ├── id.txt
│   └── en.txt
└── caption/
    ├── id.txt
    └── en.txt
```

Jangan menggunakan satu prompt yang hanya diterjemahkan secara literal. Setiap prompt harus disesuaikan dengan gaya komunikasi, hook, dan pola bahasa target.

### Endpoint yang Disarankan

```text
GET  /public/languages
GET  /user/language-preference
PUT  /user/language-preference
POST /clipping/detect-language
POST /clipping/token-estimation
```

Contoh response deteksi bahasa:

```json
{
  "detected_language": "en",
  "language_name": "English",
  "confidence": 0.96,
  "supported": true
}
```

### Cache dan Fallback

- Gunakan translation key, bukan teks hardcoded.
- Cache file translation agar pergantian bahasa cepat.
- Gunakan bahasa Inggris sebagai fallback jika key tidak tersedia.
- Catat missing translation key pada development atau monitoring log.
- Jangan menerjemahkan data dinamis seperti nama package, kecuali tersedia versi lokalnya.
