import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, computeFaktur, detectVatMode } from "../src/calc.js";
import { formatSen, mulDiv } from "../src/money.js";
import { DEFAULT_UNITS } from "../src/satuan.js";

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
