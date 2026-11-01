# FP MMM: Invoice PDF ke XML Coretax

Aplikasi web untuk mengubah PDF "Sales Invoice" menjadi file XML faktur pajak keluaran yang bisa diimpor ke Coretax. Bisa dipakai dari HP, tablet, atau laptop.

Buka aplikasinya di **https://vill0701.github.io/fp-mmm/** (mode coba tanpa data master: https://vill0701.github.io/fp-mmm/?coba).

## Cara pakai

1. Pilih satu atau beberapa PDF invoice. PDF dibaca di perangkat, tidak di-upload ke mana pun.
2. Aplikasi memeriksa setiap invoice: halaman lengkap, jumlah baris sama dengan Sub Total, harga sudah atau belum termasuk PPN, dan PPN faktur sama dengan PPN invoice.
3. Lengkapi yang kurang (NPWP pembeli, kode barang, satuan). Isian diingat untuk invoice berikutnya.
4. Download XML, lalu impor di Coretax.

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
