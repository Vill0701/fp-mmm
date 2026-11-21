import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, computeFaktur, detectVatMode } from "../src/calc.js";
import { formatSen, mulDiv } from "../src/money.js";
import { DEFAULT_UNITS } from "../src/satuan.js";
import { buildXml, readXml, verifyXml } from "../src/xml.js";
import { compareCoretax } from "../src/coretax-pdf.js";

// Data uji buatan, bukan NPWP asli.
const NPWP = "1".repeat(16);
const master = {
  customers: [{ name: "PT CONTOH JAYA", npwp: NPWP, nitku: NPWP + "000000" }],
  items: {
    A1: { coretaxCode: "731800" },
    B2: { coretaxCode: "320000" },
    "BIAYA KIRIM": { coretaxCode: "000000", unit: "UM.0033" },
  },
  units: DEFAULT_UNITS,
};

function invoice(lines, summary) {
  return {
    number: "SI.UJI.00001",
    date: "2026-10-30",
    buyerName: "PT. Contoh  Jaya",
    pages: [{ index: 1, of: 1 }],
    lines: lines.map(([code, qty, unit, price, total, disc = "0"], i) => ({
      no: i + 1, code, name: `BARANG ${code}`, qty, unit, price, disc, total: total ?? qty * price,
    })),
    summary: { discount: 0, shipping: 0, ...summary },
    warnings: [],
  };
}
const problems = (f) => f.checks.filter((c) => c.level === "error" || c.level === "warn").map((c) => c.message);
const rupiahOf = (f, key) => f.lines.map((l) => l[key] / 100);

test("pembulatan dan format angka", () => {
  assert.equal(mulDiv(43000000, 11, 12), 39416667); // 394.166,666… → 394.166,67
  assert.equal(mulDiv(39416667, 12, 10000), 47300);
  assert.equal(mulDiv(5, 1, 2), 3);
  assert.equal(mulDiv(-5, 1, 2), -3);
  assert.equal(formatSen(39416667), "394166.67");
  assert.equal(formatSen(223437500), "2234375");
  assert.equal(formatSen(12350), "123.5");
  assert.equal(formatSen(0), "0");
});

test("diskon total dibagi proporsional dan jumlahnya pas", () => {
  assert.deepEqual(allocate(1000000, [10000000, 5000000, 5000000]), [500000, 250000, 250000]);
  const parts = allocate(100000, [3333300, 3333300, 3333400]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100000);
  assert.ok(parts.every((p) => p % 100 === 0));
});

test("harga belum termasuk PPN, dengan diskon per baris dan diskon total", () => {
  // A1: 10 × 10.000 diskon 10% = 90.000; B2: 2 × 50.000 = 100.000; diskon total 19.000
  const inv = invoice(
    [["A1", 10, "PCS", 10000, 90000, "10"], ["B2", 2, "KLG", 50000]],
    { subTotal: 190000, discount: 19000, ppn: 18810, total: 189810 },
  );
  const f = computeFaktur(inv, master);
  assert.deepEqual(problems(f), []);
  assert.equal(f.vatMode.mode, "exclusive");
  assert.deepEqual(rupiahOf(f, "discountSen"), [19000, 10000]); // 10.000 + 9.000 bagian diskon total, dan 10.000
  assert.deepEqual(rupiahOf(f, "taxBaseSen"), [81000, 90000]);
  assert.deepEqual(rupiahOf(f, "vatSen"), [8910, 9900]);
  assert.equal(f.ready, true);
});

test("harga sudah termasuk PPN dibagi 1,11 dulu", () => {
  const inv = invoice([["A1", 2, "PCS", 111000], ["B2", 1, "KLG", 55500]], { subTotal: 277500, ppn: 27500, total: 277500 });
  assert.equal(detectVatMode(inv.summary, 2).mode, "inclusive");
  const f = computeFaktur(inv, master);
  assert.deepEqual(problems(f), []);
  assert.deepEqual(rupiahOf(f, "priceSen"), [100000, 50000]);
  assert.deepEqual(rupiahOf(f, "taxBaseSen"), [200000, 50000]);
  assert.equal(f.totals.vatSen / 100, 27500);
});

test("harga termasuk PPN dengan PPN invoice yang dibulatkan: 2 × 150.000, PPN 29.730", () => {
  const inv = invoice([["A1", 2, "PACK", 150000]], { subTotal: 300000, ppn: 29730, total: 300000 });
  const m = { ...master, units: { ...DEFAULT_UNITS, PACK: "UM.0033" } };

  let f = computeFaktur(inv, m); // pembulatan ke sen
  assert.deepEqual(problems(f), []);
  assert.equal(f.vatMode.mode, "inclusive");
  assert.deepEqual([f.lines[0].priceSen, f.totals.taxBaseSen, f.totals.otherTaxBaseSen, f.totals.vatSen], [13513514, 27027028, 24774776, 2973000]);

  f = computeFaktur(inv, m, { inclusiveRounding: "rupiah" });
  assert.deepEqual(problems(f), []);
  assert.deepEqual([f.lines[0].priceSen, f.totals.taxBaseSen, f.totals.otherTaxBaseSen, f.totals.vatSen], [13513500, 27027000, 24774750, 2973000]);
});

test("biaya kirim menjadi baris faktur tersendiri", () => {
  // PPN invoice belum termasuk biaya kirim
  let f = computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 11000, total: 121000 }), master);
  assert.deepEqual(problems(f), []);
  assert.deepEqual(f.vatMode, { mode: "exclusive", withShipping: false });
  assert.deepEqual(f.lines.map((l) => [l.name, l.code, l.unit, l.taxBaseSen / 100, l.vatSen / 100]), [
    ["BARANG A1", "731800", "UM.0021", 100000, 11000],
    ["BIAYA KIRIM", "000000", "UM.0033", 10000, 1100],
  ]);

  // PPN invoice sudah termasuk biaya kirim
  f = computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 12100, total: 122100 }), master);
  assert.deepEqual(problems(f), []);
  assert.deepEqual(f.vatMode, { mode: "exclusive", withShipping: true });
  assert.equal(f.totals.vatSen / 100, 12100);
});

test("total faktur dibandingkan dengan invoice untuk rekap, dibulatkan ke rupiah", () => {
  // Harga belum termasuk PPN, dengan diskon: DPP = Sub Total − Diskon, PPN = PPN invoice
  const f = computeFaktur(invoice([["A1", 10, "PCS", 10000, 90000, "10"], ["B2", 2, "KLG", 50000]], { subTotal: 190000, discount: 19000, ppn: 18810, total: 189810 }), master);
  assert.equal(f.totals.discountSen, 2900000);
  assert.deepEqual(f.compared, [
    { label: "DPP", sen: 17100000, want: 171000, diff: 0 },
    { label: "PPN", sen: 1881000, want: 18810, diff: 0 },
  ]);
  // PPN invoice belum termasuk biaya kirim: PPN faktur = PPN invoice + PPN biaya kirim
  const ship = computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 11000, total: 121000 }), master);
  assert.deepEqual(ship.compared.map((c) => [c.label, c.want, c.diff]), [["DPP", 110000, 0], ["PPN", 12100, 0]]);
  // Harga termasuk PPN: DPP tidak tercetak di invoice, jadi hanya PPN yang dibandingkan
  const incl = computeFaktur(invoice([["A1", 2, "PCS", 111000], ["B2", 1, "KLG", 55500]], { subTotal: 277500, ppn: 27500, total: 277500 }), master);
  assert.deepEqual(incl.compared.map((c) => [c.label, c.want, c.diff]), [["PPN", 27500, 0]]);
  // Rumus PPN tidak dikenali: tidak ada yang dibandingkan
  assert.deepEqual(computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, ppn: 5000, total: 105000 }), master).compared, []);
});

test("PPN yang tidak cocok dengan rumus mana pun ditandai", () => {
  const f = computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, ppn: 5000, total: 105000 }), master);
  assert.equal(f.vatMode.mode, "unknown");
  assert.equal(f.ready, false);
});

test("pembeli dan kode barang yang belum ada di data master ditandai", () => {
  const f = computeFaktur(
    { ...invoice([["Z9", 1, "GLN", 100000]], { subTotal: 100000, ppn: 11000, total: 111000 }), buyerName: "PT LAIN" },
    master,
  );
  assert.equal(f.ready, false);
  assert.deepEqual(f.checks.filter((c) => c.level === "error").map((c) => c.message), [
    'Pembeli "PT LAIN" belum ada di data master',
    "Kode barang Coretax belum diisi untuk 1 baris",
    "Satuan Coretax belum diisi untuk 1 baris",
  ]);
});

test("bagian invoice yang bermasalah ditandai untuk Lihat PDF", () => {
  const good = computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, ppn: 11000, total: 111000 }), master);
  assert.deepEqual(good.flags, { lines: [], summary: [], header: [] });
  // Baris 2: Total Harga lebih besar dari Qty × @Harga; pembeli tidak ada di data master
  const bad = computeFaktur({ ...invoice([["A1", 1, "PCS", 100000], ["B2", 1, "KLG", 50000, 60000]], { subTotal: 160000, ppn: 17600, total: 177600 }), buyerName: "PT LAIN" }, master);
  assert.deepEqual(bad.flags.lines, [1]);
  assert.deepEqual(bad.flags.header, ["buyer"]);
});

test("XML dibaca ulang dan diperiksa sebelum download", () => {
  const seller = { tin: NPWP, idtku: NPWP + "000000" };
  const fakturs = [
    computeFaktur(invoice([["A1", 10, "PCS", 10000, 90000, "10"], ["B2", 2, "KLG", 50000]], { subTotal: 190000, discount: 19000, ppn: 18810, total: 189810 }), master),
    computeFaktur({ ...invoice([["A1", 2, "PCS", 111000], ["B2", 1, "KLG", 55500]], { subTotal: 277500, ppn: 27500, total: 277500 }), number: "SI.UJI.00002" }, master),
    computeFaktur({ ...invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 11000, total: 121000 }), number: "SI.UJI.00003" }, master),
  ];
  assert.ok(fakturs.every((f) => f.ready));
  const xml = buildXml(seller, fakturs);
  const read = readXml(xml);
  assert.deepEqual(read.fakturs.map((x) => x.totals), fakturs.map((f) => f.totals));
  assert.deepEqual(verifyXml(xml, seller, fakturs), []);
  // Isi yang berbeda dari layar tertangkap
  assert.deepEqual(verifyXml(xml.replace("<VAT>8910</VAT>", "<VAT>8911</VAT>"), seller, fakturs), [
    "SI.UJI.00001: baris 1: PPN di XML tidak sama dengan di layar",
    "SI.UJI.00001: baris 1: PPN tidak sama dengan 12% × DPP Nilai Lain",
    "SI.UJI.00001: total faktur di XML tidak sama dengan rekap",
  ]);
  assert.deepEqual(verifyXml(xml.replace("<RefDesc>SI.UJI.00002</RefDesc>", "<RefDesc>SI.UJI.00001</RefDesc>"), seller, fakturs), [
    "SI.UJI.00001: nomor referensi muncul lebih dari sekali",
    "SI.UJI.00002: nomor referensi di XML tidak sama dengan di layar",
  ]);
  assert.deepEqual(verifyXml(xml, { ...seller, tin: "5".repeat(16) }, fakturs), ["NPWP penjual di XML tidak sama dengan Pengaturan, atau bukan 16 angka"]);
});

/** Faktur Coretax tiruan seperti hasil readCoretaxFakturs: Harga × Qty per baris, total dibulatkan ke rupiah. */
function coretaxOf(f) {
  const rp = (sen) => Math.round(sen / 100) * 100;
  const goods = f.lines.map((l, i) => ({ no: i + 1, name: l.name, priceSen: l.priceSen, qty: l.qty, unit: l.unit, code: l.code, grossSen: l.taxBaseSen + l.discountSen, discountSen: l.discountSen }));
  return {
    ref: f.number,
    number: "0".repeat(17),
    buyerName: "PT CONTOH JAYA",
    buyerNpwp: f.customer.npwp,
    buyerNitku: f.customer.nitku,
    goods,
    grossSen: rp(goods.reduce((a, g) => a + g.grossSen, 0)),
    discountSen: rp(f.totals.discountSen),
    otherTaxBaseSen: rp(f.totals.otherTaxBaseSen),
    vatSen: rp(f.totals.vatSen),
  };
}

test("faktur Coretax dicocokkan dengan faktur buatan aplikasi (daftar dan Riwayat)", () => {
  const fakturs = [
    computeFaktur(invoice([["A1", 10, "PCS", 10000, 90000, "10"], ["B2", 2, "KLG", 50000]], { subTotal: 190000, discount: 19000, ppn: 18810, total: 189810 }), master),
    computeFaktur(invoice([["A1", 2, "PCS", 111000], ["B2", 1, "KLG", 55500]], { subTotal: 277500, ppn: 27500, total: 277500 }), master), // harga termasuk PPN
    computeFaktur(invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 11000, total: 121000 }), master), // biaya kirim
  ];
  for (const f of fakturs) {
    const ours = { npwp: f.customer.npwp, nitku: f.customer.nitku, totals: f.totals, lines: f.lines };
    const rows = compareCoretax(coretaxOf(f), ours);
    assert.deepEqual(rows.filter((r) => !r.ok), []);
    assert.equal(rows.length, 6 + 1 + 7 * f.lines.length);
    // Dari Riwayat hanya total yang tersimpan (angka sen dari riwayat.csv)
    assert.ok(compareCoretax(coretaxOf(f), { totals: { ...f.totals } }).every((r) => r.ok));
  }
  // Qty yang berbeda di Coretax tertangkap per baris
  const f = fakturs[0];
  const c = coretaxOf(f);
  c.goods[1] = { ...c.goods[1], qty: 3 };
  assert.deepEqual(compareCoretax(c, { npwp: f.customer.npwp, nitku: f.customer.nitku, totals: f.totals, lines: f.lines }).filter((r) => !r.ok).map((r) => r.label), ["Baris 2: Qty"]);
  // NPWP pembeli yang berbeda tertangkap
  assert.deepEqual(compareCoretax({ ...c, goods: coretaxOf(f).goods, buyerNpwp: "3".repeat(16) }, { npwp: f.customer.npwp, totals: f.totals }).filter((r) => !r.ok).map((r) => r.label), ["NPWP pembeli"]);
});

test("baris yang tidak bisa dipakai menahan faktur; setelah dihapus faktur siap dan XML hanya berisi barang asli", () => {
  const base = invoice([["A1", 2, "PCS", 100000], ["B2", 1, "KLG", 50000]], { subTotal: 250000, ppn: 27500, total: 277500 });
  // Baris 3: label LUNAS yang ditulis sebagai baris bernomor, tanpa angka
  const label = { no: 3, code: "", name: "LUNAS", qty: null, unit: "", price: null, disc: "", total: null, issues: ["Qty kosong", "@Harga kosong", "Total Harga kosong", "nama barangnya label, bukan barang"] };
  const inv = { ...base, lines: [...base.lines, label] };
  const f = computeFaktur(inv, master);
  assert.equal(f.ready, false);
  assert.deepEqual(problems(f), ['Baris 3 "LUNAS" tidak terbaca lengkap (Qty kosong; @Harga kosong; Total Harga kosong; nama barangnya label, bukan barang). Kalau ini bukan barang, hapus baris ini.']);
  assert.deepEqual(f.flags.lines, [2]);
  assert.deepEqual(f.lines.map((l) => [l.pos, l.incomplete]), [[1, false], [2, false], [3, true]]);
  assert.deepEqual(f.removed, []);

  // Label dengan angka nol pun tetap ditahan, karena bukan barang
  const zero = computeFaktur({ ...base, lines: [...base.lines, { ...label, qty: 0, price: 0, total: 0, issues: ["nama barangnya label, bukan barang"] }] }, master);
  assert.deepEqual(problems(zero), ['Baris 3 "LUNAS" tidak bisa masuk faktur (nama barangnya label, bukan barang). Kalau ini bukan barang, hapus baris ini.']);

  // Dihapus (menurut urutan baris): faktur siap, baris faktur tetap bernomor seperti di invoice
  const g = computeFaktur({ ...inv, removed: [3] }, master);
  assert.deepEqual(problems(g), []);
  assert.deepEqual(g.lines.map((l) => l.pos), [1, 2]);
  assert.deepEqual(g.removed, [3]);
  assert.ok(g.checks.some((c) => c.level === "info" && c.message === 'Baris 3 "LUNAS" dihapus dari faktur atas pilihanmu'));
  const seller = { tin: NPWP, idtku: NPWP + "000000" };
  const xml = buildXml(seller, [g]);
  assert.equal(xml.match(/<GoodService>/g).length, 2);
  assert.ok(!xml.includes("LUNAS"));
  assert.deepEqual(verifyXml(xml, seller, [g]), []);

  // Yang terhapus ternyata barang asli: ketahuan karena jumlah baris tidak lagi sama dengan Sub Total
  const h = computeFaktur({ ...inv, removed: [1, 3] }, master);
  assert.equal(h.ready, false);
  assert.ok(problems(h).some((m) => /tidak sama dengan Sub Total/.test(m)));

  // Nomor tercetak kembar: yang dihapus hanya baris di urutan itu
  const twin = computeFaktur({ ...base, lines: [base.lines[0], base.lines[1], { ...label, no: 2 }], removed: [3] }, master);
  assert.deepEqual(twin.lines.map((l) => [l.pos, l.no]), [[1, 1], [2, 2]]);

  // Catatan label LUNAS dari pembaca PDF hanya info; biaya kirim tidak punya urutan baris, jadi tidak bisa dihapus
  const n = computeFaktur({ ...invoice([["A1", 1, "PCS", 100000]], { subTotal: 100000, shipping: 10000, ppn: 11000, total: 121000 }), notes: ['Hal. 1: tulisan "LUNAS" di tabel diabaikan: itu label, bukan barang'] }, master);
  assert.ok(n.ready);
  assert.ok(n.checks.some((c) => c.level === "info" && /LUNAS/.test(c.message)));
  assert.deepEqual(n.lines.map((l) => l.pos), [1, undefined]);
});
