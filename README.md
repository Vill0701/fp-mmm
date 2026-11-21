# FP MMM: Invoice PDF ke XML Coretax

Aplikasi web untuk mengubah PDF "Sales Invoice" menjadi file XML faktur pajak keluaran yang bisa diimpor ke Coretax. Bisa dipakai dari HP, tablet, atau laptop.

Buka aplikasinya di **https://vill0701.github.io/fp-mmm/** (mode coba tanpa data master: https://vill0701.github.io/fp-mmm/?coba).

## Cara pakai

1. Pilih satu atau beberapa PDF invoice, atau seret file PDF ke jendela aplikasi. PDF dibaca di perangkat, tidak di-upload ke mana pun.
2. Aplikasi memeriksa setiap invoice: halaman lengkap, jumlah baris sama dengan Sub Total, harga sudah atau belum termasuk PPN, dan PPN faktur sama dengan PPN invoice. Tombol **Lihat PDF** menampilkan halaman invoice asli (semua halamannya) di samping yang dibaca aplikasi; bagian yang dibaca diberi tanda kuning dan baris barang bernomor, jadi baris yang tidak terbaca kelihatan karena tidak bertanda. Bagian yang bermasalah menurut pemeriksaan diberi tanda merah. Invoice yang sudah siap dilipat jadi satu baris, dan daftar bisa disaring menurut status (Siap, Perlu dicek, Belum siap).
   - Tulisan status bayar di area tabel, seperti **LUNAS**, **Belum Lunas**, **L U N A S**, atau **LUNAS 19/11/2026**, bukan barang: diabaikan dan tidak disambung ke nama barang di atasnya. Pemeriksaan mencatat tulisan apa saja yang diabaikan. Kalau label itu ditulis sebagai baris bernomor, barisnya tetap tampil supaya bisa dihapus.
   - Baris yang tidak bisa jadi baris faktur (angkanya tidak terbaca, tanpa nama barang, atau berisi label LUNAS) menahan faktur dan diberi tombol **Hapus baris ini**. Baris lain juga bisa dihapus lewat tombol **Hapus** kecil di sampingnya. Baris yang dihapus tidak masuk XML. Daftarnya tetap ada di kartu invoice, bisa dikembalikan, dan diberi tanda abu-abu di Lihat PDF. Kalau yang terhapus ternyata barang, jumlah baris tidak lagi sama dengan Sub Total, jadi faktur tertahan lagi.
3. Lengkapi yang kurang (NPWP pembeli, kode barang, satuan). Isian diingat untuk invoice berikutnya.
4. Cek **Rekap XML** di bawah daftar: Referensi, Nama Pembeli, Harga Jual, DPP Nilai Lain, dan PPN tiap faktur, dibulatkan ke rupiah seperti di daftar faktur Coretax, dengan ✓ kalau sama dengan invoice. Rekap bisa disalin untuk ditempel di Excel. Sebelum download, isi file XML dibaca ulang dan dicocokkan dengan rekap ini serta dengan format Coretax; kalau ada yang tidak sesuai, download dikunci.
5. Download XML, lalu impor di Coretax. Cocokkan daftar faktur di Coretax dengan rekap lewat nomor Referensi. Nama pembeli di Coretax diisi dari NPWP di data master, jadi nama yang berbeda berarti NPWP pelanggan itu perlu dicek. Rekap setiap XML tersimpan di **Riwayat** (di data master, jadi terlihat dari semua perangkat) dan bisa disalin ke Excel.
6. Invoice yang sudah pernah dibuatkan XML tertahan sampai dipilih: **Hapus dari daftar** atau **Tetap buat lagi**, supaya faktur tidak terbit dua kali di Coretax. Download ulang file yang baru saja dibuat cukup dengan konfirmasi.
7. Setelah faktur terbit, pilih PDF faktur dari Coretax (bisa bersama invoicenya). Aplikasi mencocokkannya lewat nomor Referensi: NPWP dan NITKU pembeli, tiap baris barang, dan total. Kalau invoicenya sudah tidak di daftar, yang dicocokkan total dari Riwayat. Nomor versi aplikasi ada di Data master → Pengaturan.

## Data

Repo ini hanya berisi kode. Data master (NPWP pelanggan, kode barang, pengaturan) disimpan di repo GitHub **private** terpisah dan dibuka dengan token yang tersimpan terenkripsi PIN di perangkat. Aplikasi menolak repo data yang bersifat public.

Commit yang membawa file data (PDF, XML, CSV, Excel, folder `contoh/` dan `data/`) atau angka mirip NPWP ditolak otomatis oleh `.githooks/pre-commit`. Aktifkan sekali di setiap salinan repo:

```
git config core.hooksPath .githooks
```

## Pengembangan

- `npm test`: jalankan tes. Tes dengan file contoh asli hanya berjalan kalau folder `contoh/` ada di laptop.
- `npm start`: coba di http://localhost:8080 (mode coba tanpa data master: http://localhost:8080/?coba).
- `npm run vendor`: salin PDF.js ke `vendor/` setelah memperbarui `pdfjs-dist`.
