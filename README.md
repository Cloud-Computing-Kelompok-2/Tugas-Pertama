# Portal Ujian Online CBT (Kelompok 2)

Stack: Node.js + Express, MySQL, HTML + vanilla JS. Backend stateless: jawaban dan session disimpan di MySQL.

## Menjalankan di localhost
1. Pastikan MySQL berjalan (XAMPP / MySQL Server) dan Node.js 18+ terpasang.
2. `cp .env.example .env` lalu isi `DB_USER` dan `DB_PASSWORD` (Windows: `copy .env.example .env`).
3. `npm install`
4. `npm run setup`  (membuat database, tabel, dan data dummy)
5. `npm start`
6. Buka http://localhost:3000. Login: NIM `2024001` s.d. `2024005`, password `password123`.

## Uji skenario DR (mini)
1. Login, jawab beberapa soal sampai muncul "Tersimpan ✓".
2. Matikan backend (Ctrl+C di terminal). Klik jawaban lain: status berubah menjadi "Menyambungkan ulang...".
3. Jalankan `npm start` lagi. Status kembali "Tersimpan ✓" otomatis, atau refresh: jawaban dan sisa waktu tetap ada.
4. Cek di MySQL: `SELECT COUNT(*) FROM answers;`

## Endpoint
GET /health, POST /api/login, GET /api/me, POST /api/logout, GET /api/exams, GET /api/exams/:id/questions,
POST /api/sessions/start, GET /api/sessions/:id, PUT /api/sessions/:id/answers, POST /api/sessions/:id/finish
