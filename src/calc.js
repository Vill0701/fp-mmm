// Menghitung isi faktur (DPP, DPP Nilai Lain, PPN) dari invoice yang sudah dibaca,
// sekaligus semua pengecekan yang hasilnya ditampilkan ke pengguna.
import { mulDiv, rupiah, toSen } from "./money.js";
import { parseNumber } from "./parser.js";
import { normalizeUnit } from "./satuan.js";

export const DEFAULT_SETTINGS = {
  trxCode: "04",
  opt: "A",
  buyerName: "Kongsi PPN", // nama & alamat asli diisi otomatis oleh Coretax dari NPWP pembeli
  buyerAddress: "Jalan Jakarta",
  vatRate: 12, // PPN = 12% dari DPP Nilai Lain
  otherBaseNum: 11, // DPP Nilai Lain = 11/12 dari harga jual
  otherBaseDen: 12,
  shippingCode: "BIAYA KIRIM", // kunci data master untuk baris biaya kirim
  shippingName: "BIAYA KIRIM",
  inclusiveRounding: "sen", // harga termasuk PPN ÷ 1,11 dibulatkan ke "sen" (2 desimal) atau "rupiah"
};

/** Kunci pencocokan nama pembeli: huruf besar, tanpa titik/koma, spasi tunggal. */
export const customerKey = (name) => name.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

export function findCustomer(customers, name) {
  const key = customerKey(name);
  return customers.find((c) => customerKey(c.name) === key) ?? null;
}

/**
 * Tentukan dari angka PPN di invoice apakah harga barang belum atau sudah termasuk PPN.
 * Belum termasuk: PPN = 12% × 11/12 × dasar = 11% × dasar.
 * Sudah termasuk: dasar = harga jual × 1,11, jadi PPN = 11/111 × dasar.
 * Dasar = Sub Total − Diskon, dicoba tanpa dan dengan biaya kirim.
 */
export function detectVatMode(summary, lineCount, settings = DEFAULT_SETTINGS) {
  const { subTotal = 0, discount = 0, shipping = 0, ppn = 0 } = summary ?? {};
  const rateNum = settings.vatRate * settings.otherBaseNum; // 132
  const rateDen = settings.otherBaseDen * 100; // 1200 → 132/1200 = 11%
  const tolerance = Math.max(1, Math.ceil(lineCount / 2)); // selisih pembulatan per baris
  for (const withShipping of shipping ? [false, true] : [false]) {
    const base = subTotal - discount + (withShipping ? shipping : 0);
    if (base <= 0) continue;
    if (Math.abs(ppn - (base * rateNum) / rateDen) <= tolerance) return { mode: "exclusive", withShipping };
    if (Math.abs(ppn - (base * rateNum) / (rateDen + rateNum)) <= tolerance) return { mode: "inclusive", withShipping };
  }
  return { mode: "unknown", withShipping: false };
}

/** Bagi `amountSen` ke tiap baris sesuai bobotnya; sisa pembulatan masuk ke baris terbesar. */
export function allocate(amountSen, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!amountSen || !total) return weights.map(() => 0);
  const unit = amountSen % 100 === 0 ? 100 : 1; // dibagi per rupiah penuh kalau bisa
  const parts = weights.map((w) => mulDiv(amountSen / unit, w, total) * unit);
  parts[weights.indexOf(Math.max(...weights))] += amountSen - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** Apakah kolom Disc cocok dengan selisih Qty × Harga − Total Harga (rupiah per baris, per unit, atau persen). */
function discountColumnMatches(line, lineDiscSen) {
  const text = line.disc.trim();
  const isPercent = text.endsWith("%");
  const value = text === "" ? 0 : parseNumber(isPercent ? text.slice(0, -1) : text);
  if (value == null) return false;
  const gross = Math.round(line.qty * line.price * 100);
  const candidates = isPercent
    ? [Math.round((gross * value) / 100)]
    : [toSen(value), Math.round(toSen(value) * line.qty), Math.round((gross * value) / 100)];
  return candidates.some((c) => Math.abs(c - lineDiscSen) <= 100);
}

/**
 * Susun satu faktur dari satu invoice.
 * master = { customers: [{ name, npwp, nitku, trxCode? }], items: { [kodeInternal]: { coretaxCode, unit?, opt? } },
 *            units: { [satuanInvoice]: "UM.xxxx" } }
 */
export function computeFaktur(invoice, master, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const checks = [];
  const check = (level, message) => checks.push({ level, message });
  const sum = { subTotal: 0, discount: 0, ppn: 0, shipping: 0, total: 0, ...invoice.summary };
  const tolerance = Math.max(1, Math.ceil(invoice.lines.length / 2)) * 100; // sen

  for (const w of invoice.warnings) check("warn", w);

  // 1. Semua halaman ada
  const pageCount = invoice.pages[0]?.of;
  const missing = [];
  for (let i = 1; i <= (pageCount ?? 0); i++) if (!invoice.pages.some((p) => p.index === i)) missing.push(i);
  if (!pageCount) check("warn", "Keterangan halaman tidak ditemukan");
  else if (missing.length) check("error", `Halaman ${missing.join(", ")} dari ${pageCount} tidak ada di PDF`);
  else check("ok", `${pageCount} halaman terbaca lengkap`);

  if (!invoice.summary) check("error", "Ringkasan (Sub Total, PPN, Total) tidak ditemukan");
  if (!invoice.lines.length) check("error", "Tidak ada baris barang yang terbaca");

  // 2. Baris barang lengkap: nomor urut dan jumlahnya sama dengan Sub Total
  if (invoice.lines.some((l, i) => l.no !== i + 1)) {
    check("warn", "Nomor urut baris barang tidak berurutan, mungkin ada baris yang terlewat");
  }
  const linesTotal = invoice.lines.reduce((a, l) => a + toSen(l.total ?? 0), 0);
  if (linesTotal !== toSen(sum.subTotal)) {
    check("error", `Jumlah semua baris (${rupiah(linesTotal)}) tidak sama dengan Sub Total (${rupiah(toSen(sum.subTotal))})`);
  } else {
    check("ok", `Jumlah ${invoice.lines.length} baris barang sama dengan Sub Total`);
  }

  // 3. Diskon per baris
  for (const l of invoice.lines) {
    const lineDisc = Math.round(l.qty * l.price * 100) - toSen(l.total);
    if (lineDisc < 0) check("error", `Baris ${l.no}: Total Harga lebih besar dari Qty × @Harga`);
    else if (!discountColumnMatches(l, lineDisc)) {
      check("warn", `Baris ${l.no}: kolom Disc (${l.disc || "kosong"}) tidak cocok dengan selisih harga (${rupiah(lineDisc)})`);
    }
  }

  // 4. Harga belum / sudah termasuk PPN
  const vat = detectVatMode(sum, invoice.lines.length, s);
  const inclusive = vat.mode === "inclusive";
  if (vat.mode === "exclusive") check("ok", "Harga belum termasuk PPN (PPN invoice = 12% × 11/12 × DPP)");
  else if (inclusive) check("info", "Harga di invoice sudah termasuk PPN: harga jual dihitung dengan membagi 1,11");
  else check("error", "PPN di invoice tidak cocok dengan rumus harga belum maupun sudah termasuk PPN, perlu dicek manual");
  if (sum.shipping && vat.mode !== "unknown") {
    check("info", vat.withShipping ? "PPN di invoice sudah termasuk biaya kirim" : "PPN di invoice belum termasuk biaya kirim");
  }

  const expectedTotal = sum.subTotal - sum.discount + sum.shipping + (inclusive ? 0 : sum.ppn);
  if (invoice.summary && Math.abs(expectedTotal - sum.total) > 1) {
    check("warn", `Total invoice (${rupiah(toSen(sum.total))}) tidak sama dengan perhitungan (${rupiah(toSen(expectedTotal))})`);
  }

  // 5. Baris faktur
  // Harga termasuk PPN = harga jual × (1 + 12% × 11/12) = harga jual × 1332/1200 (= 1,11)
  const inclNum = s.otherBaseDen * 100;
  const inclDen = s.otherBaseDen * 100 + s.vatRate * s.otherBaseNum;
  const toExcl = (sen) => {
    if (!inclusive) return sen;
    return s.inclusiveRounding === "rupiah" ? mulDiv(sen, inclNum, inclDen * 100) * 100 : mulDiv(sen, inclNum, inclDen);
  };
  const discountParts = allocate(toSen(sum.discount), invoice.lines.map((l) => toSen(l.total)));
  const rows = invoice.lines.map((l, i) => ({
    itemCode: l.code || l.name, // barang tanpa kode diingat lewat namanya
    name: l.name,
    invoiceUnit: l.unit,
    qty: l.qty,
    priceSen: toExcl(toSen(l.price)),
    discountSen: toExcl(Math.round(l.qty * l.price * 100) - toSen(l.total) + discountParts[i]),
  }));
  if (sum.shipping) {
    rows.push({ itemCode: s.shippingCode, name: s.shippingName, invoiceUnit: "", qty: 1, priceSen: toExcl(toSen(sum.shipping)), discountSen: 0 });
  }

  const lines = rows.map((r) => {
    const item = master.items?.[r.itemCode] ?? {};
    const taxBaseSen = Math.round(r.priceSen * r.qty) - r.discountSen;
    const otherTaxBaseSen = mulDiv(taxBaseSen, s.otherBaseNum, s.otherBaseDen);
    return {
      ...r,
      opt: item.opt || s.opt,
      code: item.coretaxCode || "",
      unit: item.unit || master.units?.[normalizeUnit(r.invoiceUnit)] || "",
      taxBaseSen,
      otherTaxBaseSen,
      vatSen: mulDiv(otherTaxBaseSen, s.vatRate, 100 * 100) * 100, // PPN dibulatkan ke rupiah penuh
    };
  });

  const totals = {
    discountSen: lines.reduce((a, l) => a + l.discountSen, 0),
    taxBaseSen: lines.reduce((a, l) => a + l.taxBaseSen, 0),
    otherTaxBaseSen: lines.reduce((a, l) => a + l.otherTaxBaseSen, 0),
    vatSen: lines.reduce((a, l) => a + l.vatSen, 0),
  };

  // 6. Hasil faktur dicocokkan lagi dengan invoice. `compared` dipakai rekap: total faktur dan angka invoice,
  //    dibulatkan ke rupiah seperti di daftar faktur Coretax.
  const compared = [];
  const compare = (label, sen, wantSen) => {
    const want = Math.round(wantSen / 100);
    compared.push({ label, sen, want, diff: Math.round(sen / 100) - want });
  };
  if (vat.mode === "exclusive") {
    const expectedBase = toSen(sum.subTotal - sum.discount + sum.shipping);
    if (totals.taxBaseSen !== expectedBase) {
      check("error", `Total DPP faktur (${rupiah(totals.taxBaseSen)}) tidak sama dengan invoice (${rupiah(expectedBase)})`);
    }
    compare("DPP", totals.taxBaseSen, expectedBase);
  }
  if (vat.mode !== "unknown") {
    const shippingLine = sum.shipping ? lines.at(-1) : null;
    const expectedVat = toSen(sum.ppn) + (shippingLine && !vat.withShipping ? shippingLine.vatSen : 0);
    const diff = totals.vatSen - expectedVat;
    if (diff === 0) check("ok", `PPN faktur sama dengan invoice (${rupiah(totals.vatSen)})`);
    else if (Math.abs(diff) <= tolerance) check("info", `PPN faktur ${rupiah(totals.vatSen)}, selisih pembulatan ${rupiah(diff)} dari invoice`);
    else check("warn", `PPN faktur ${rupiah(totals.vatSen)} berbeda ${rupiah(diff)} dari invoice (${rupiah(expectedVat)})`);
    compare("PPN", totals.vatSen, expectedVat);
  }

  // 7. Data master: pembeli, kode barang, satuan
  const customer = findCustomer(master.customers ?? [], invoice.buyerName);
  if (!customer) check("error", `Pembeli "${invoice.buyerName}" belum ada di data master`);
  else {
    if (!/^\d{16}$/.test(customer.npwp)) check("error", "NPWP pembeli di data master harus 16 digit");
    if (!/^\d{22}$/.test(customer.nitku)) check("error", "NITKU pembeli di data master harus 22 digit");
    else if (!customer.nitku.startsWith(customer.npwp)) check("warn", "NITKU pembeli tidak diawali NPWP-nya");
  }
  const noCode = lines.filter((l) => !/^\d{6}$/.test(l.code)).length;
  const noUnit = lines.filter((l) => !/^UM\.\d{4}$/.test(l.unit)).length;
  if (noCode) check("error", `Kode barang Coretax belum diisi untuk ${noCode} baris`);
  if (noUnit) check("error", `Satuan Coretax belum diisi untuk ${noUnit} baris`);

  return {
    number: invoice.number,
    date: invoice.date,
    buyerName: invoice.buyerName,
    customer,
    trxCode: customer?.trxCode || s.trxCode,
    vatMode: vat,
    lines,
    totals,
    compared, // total faktur dibandingkan dengan invoice, untuk rekap
    checks,
    ready: !checks.some((c) => c.level === "error"),
  };
}
