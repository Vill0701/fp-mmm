import assert from "node:assert/strict";
import { test } from "node:test";
import { isStamp, parseDate, parseInvoices, parseNumber } from "../src/parser.js";

/**
 * Halaman tiruan dengan tata letak seperti invoice asli (posisi dalam pt, halaman mendatar 621 × 394).
 * Kolom No, Kode Barang, dan Nama Barang rata kiri; kolom angka rata kanan terhadap judulnya.
 * Data uji buatan, bukan data asli.
 */
function page(number, { rows, extra = [] }) {
  const items = [];
  const put = (x, y, str, w = str.length * 4.5) => str && items.push({ str, x, y, w, h: 9 });
  const right = (edge, y, str) => put(edge - str.length * 4.5, y, str);
  put(470.8, 25.4, "Halaman 1 dari 1", 79.9);
  put(41, 29.3, "CV. PENJUAL CONTOH");
  put(323, 30.4, "SALES INVOICE", 91.2);
  put(323, 44.3, "Nomor", 27);
  put(372.8, 43.4, ":", 2.5);
  put(381, 43.8, "SI.UJI.00001");
  put(323, 57.3, "Tgl Faktur", 40.5);
  put(372.8, 57.4, ":", 2.5);
  put(381, 56.4, "19 Nov 2026");
  put(41, 58.3, "Kepada", 31);
  put(75, 58.3, ":", 2.5);
  put(85, 58.3, "PT. PEMBELI CONTOH");
  put(323, 70.3, "No Po", 25);
  put(372.8, 69.4, ":", 2.5);
  put(41, 72.3, "Kontak", 28);
  put(75, 72.3, ":", 2.5);
  put(85, 72.3, "BAPAK CONTOH");
  put(41, 116.8, "No", 11.5);
  put(60, 116.8, "Kode Barang", 52.5);
  put(145, 116.8, "Nama Barang", 55.5);
  put(339, 116.8, "Qty", 14);
  put(369, 117.1, "Sat", 15);
  put(415.6, 117.1, "@Harga", 37.4);
  put(485.5, 116.8, "Disc", 17.5);
  put(531, 116.8, "Total Harga", 47);
  rows.forEach(([no, code, name, qty, unit, price, disc, total], i) => {
    const y = 135.4 + i * 12;
    put(41, y, no);
    put(60, y, code);
    put(145, y, name);
    right(353, y, qty);
    right(384, y + 1, unit); // kolom Sat dan Disc sedikit lebih rendah, seperti di PDF asli
    right(453, y, price);
    right(503, y + 1, disc);
    right(578, y, total);
  });
  for (const [x, y, str] of extra) put(x, y, str);
  [["Sub Total", "250,000"], ["Discount", "0"], ["PPN", "27,500"], ["Biaya Kirim", "0"], ["Total", "277,500"]].forEach(([label, value], i) => {
    put(399, 200 + i * 13, label);
    right(578, 200 + i * 13, value);
  });
  return { number, items };
}

const ROWS = [
  ["1", "BRG-001", "BESI CONTOH A", "2", "PCS", "100,000", "0", "200,000"],
  ["2", "BRG-002", "BESI CONTOH B", "1", "PCS", "50,000", "0", "50,000"],
];
const read = (opts) => parseInvoices([page(1, { rows: ROWS, ...opts })]).invoices[0];
const summaryOf = (inv) => inv.lines.map((l) => [l.no, l.code, l.name, l.qty, l.unit, l.price, l.total]);

test("angka dan tanggal format invoice", () => {
  assert.equal(parseNumber("1,234,567"), 1234567);
  assert.equal(parseNumber("12.5"), 12.5);
  assert.equal(parseNumber("1.234"), 1.234);
  assert.equal(parseNumber("-"), null);
  assert.equal(parseDate("30 Okt 2026"), "2026-10-30");
  assert.equal(parseDate("19 Nov 2026"), "2026-11-19");
});

test("halaman tiruan terbaca seperti invoice asli", () => {
  const inv = read();
  assert.equal(inv.number, "SI.UJI.00001");
  assert.equal(inv.date, "2026-11-19");
  assert.equal(inv.buyerName, "PT. PEMBELI CONTOH");
  assert.deepEqual(summaryOf(inv), [
    [1, "BRG-001", "BESI CONTOH A", 2, "PCS", 100000, 200000],
    [2, "BRG-002", "BESI CONTOH B", 1, "PCS", 50000, 50000],
  ]);
  assert.deepEqual(inv.summary, { subTotal: 250000, discount: 0, ppn: 27500, shipping: 0, total: 277500 });
  assert.deepEqual([inv.warnings, inv.notes], [[], []]);
  assert.ok(inv.lines.every((l) => l.issues === undefined));
});

test("label LUNAS di area tabel tidak terbaca sebagai barang atau sambungan nama barang", () => {
  const clean = read();
  const cases = {
    "di antara kolom": [[250, 150, "LUNAS"]],
    "di kolom Nama Barang, baris sendiri": [[145, 159.4, "Lunas"]],
    "sebaris dengan barang, di luar kolom": [[300, 135.4, "LUNAS"]],
    "huruf terpisah": [[200, 165, "L"], [212, 165, "U"], [224, 165, "N"], [236, 165, "A"], [248, 165, "S"]],
    "belum lunas": [[145, 159.4, "BELUM LUNAS"]],
    "dengan tanggal": [[145, 159.4, "LUNAS 19/11/2026"]],
    "rata kanan di kolom Total Harga": [[578 - 5 * 4.5, 170, "LUNAS"]],
  };
  for (const [where, extra] of Object.entries(cases)) {
    const inv = read({ extra });
    assert.deepEqual(summaryOf(inv), summaryOf(clean), where);
    assert.deepEqual(inv.warnings, [], where);
    assert.equal(inv.notes.length, 1, where);
    assert.match(inv.notes[0], /^Hal\. 1: tulisan ".+" di tabel diabaikan: itu label, bukan barang$/, where);
  }
  // Teks lain tetap dibaca seperti biasa: di kolom Nama Barang menjadi sambungan nama barang di atasnya
  const other = read({ extra: [[145, 159.4, "LUNAS TGL 19/11"]] });
  assert.equal(other.lines[1].name, "BESI CONTOH B LUNAS TGL 19/11");
  assert.deepEqual(other.notes, []);

  assert.ok(["LUNAS", "Lunas", "L U N A S", "Sudah Lunas", "LUNAS 19/11/2026", "** LUNAS **"].every(isStamp));
  assert.ok(!["PELUNASAN", "LUNAS TGL 19/11", "BESI LUNAS", ""].some(isStamp));
});

test("baris bernomor berisi label LUNAS, atau angkanya tidak terbaca, mencatat masalahnya di baris itu", () => {
  const rows = [...ROWS, ["3", "", "LUNAS", "", "", "", "", ""], ["4", "", "TITIP", "", "", "x", "", ""]];
  const inv = read({ rows });
  assert.equal(inv.lines.length, 4);
  assert.deepEqual(inv.lines[2].issues, ["Qty kosong", "@Harga kosong", "Total Harga kosong", "nama barangnya label, bukan barang"]);
  assert.deepEqual(inv.lines[3].issues, ["Qty kosong", '@Harga berisi "x", bukan angka', "Total Harga kosong"]);
  assert.deepEqual([inv.warnings, inv.notes], [[], []]); // labelnya tetap kelihatan di baris 3, bukan diabaikan diam-diam
  // Tanda Lihat PDF: satu per baris, bernomor urut
  assert.deepEqual(inv.marks.filter((m) => m.kind === "line").map((m) => m.label), ["1", "2", "3", "4"]);
});
