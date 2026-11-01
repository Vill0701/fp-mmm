// Data master yang disimpan di repo GitHub private: pelanggan (NPWP), barang (kode Coretax),
// padanan satuan, pengaturan, dan riwayat invoice yang sudah dibuatkan XML.
import { customerKey } from "./calc.js";
import { parseCsv, toCsv } from "./csv.js";
import { DEFAULT_UNITS, normalizeUnit } from "./satuan.js";

export const FILES = {
  customers: "pelanggan.csv",
  items: "barang.csv",
  units: "satuan.csv",
  settings: "pengaturan.json",
  history: "riwayat.csv",
};

const COLUMNS = {
  customers: ["nama", "npwp", "nitku", "kode_transaksi"],
  items: ["kode", "nama", "kode_coretax", "satuan", "opt"],
  units: ["sat", "satuan_coretax"],
  history: ["nomor", "tanggal_invoice", "pembeli", "diekspor", "file"],
};

export const DEFAULT_MASTER_SETTINGS = {
  npwpPenjual: "",
  nitkuPenjual: "",
  namaFile: "{DD}-{MM} FP MMM",
  kodeTransaksi: "04",
  pembulatanHargaInclude: "sen", // harga yang sudah termasuk PPN dibagi 1,11: dibulatkan ke "sen" atau "rupiah"
};

/** NPWP 16 digit. Angka 15 digit (format lama, atau 0 di depan hilang karena Excel) diberi 0 di depan. */
export function normalizeNpwp(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 15) return "0" + digits;
  return digits.length === 16 ? digits : null;
}

/** NITKU 22 digit; kosong berarti kantor pusat (NPWP + 000000). */
export function normalizeNitku(value, npwp) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return npwp ? npwp + "000000" : null;
  if (digits.length === 21) return "0" + digits;
  return digits.length === 22 ? digits : null;
}

export function parseMaster(texts) {
  const rows = (key) => (texts[key] ? parseCsv(texts[key]) : []);

  const customers = rows("customers")
    .filter((r) => r.nama)
    .map((r) => {
      const npwp = normalizeNpwp(r.npwp);
      return {
        name: r.nama,
        npwp: npwp ?? r.npwp, // nilai tidak valid dibiarkan apa adanya supaya ditandai saat pengecekan
        nitku: normalizeNitku(r.nitku, npwp) ?? r.nitku,
        trxCode: r.kode_transaksi ?? "",
      };
    });

  const items = {};
  for (const r of rows("items")) {
    if (r.kode) items[r.kode] = { name: r.nama ?? "", coretaxCode: r.kode_coretax ?? "", unit: r.satuan ?? "", opt: r.opt ?? "" };
  }

  const units = { ...DEFAULT_UNITS };
  for (const r of rows("units")) if (r.sat && r.satuan_coretax) units[normalizeUnit(r.sat)] = r.satuan_coretax;

  const settings = { ...DEFAULT_MASTER_SETTINGS, ...(texts.settings ? JSON.parse(texts.settings) : {}) };

  const history = rows("history").map((r) => ({
    number: r.nomor,
    invoiceDate: r.tanggal_invoice,
    buyer: r.pembeli,
    exportedAt: r.diekspor,
    file: r.file,
  }));

  return { customers, items, units, settings, history };
}

export function serializeMaster(master, key) {
  const byText = (a, b) => a.localeCompare(b, "id");
  switch (key) {
    case "customers":
      return toCsv(
        COLUMNS.customers,
        [...master.customers]
          .sort((a, b) => byText(a.name, b.name))
          .map((c) => ({ nama: c.name, npwp: c.npwp, nitku: c.nitku, kode_transaksi: c.trxCode })),
      );
    case "items":
      return toCsv(
        COLUMNS.items,
        Object.entries(master.items)
          .sort(([a], [b]) => byText(a, b))
          .map(([kode, it]) => ({ kode, nama: it.name, kode_coretax: it.coretaxCode, satuan: it.unit, opt: it.opt })),
      );
    case "units":
      return toCsv(
        COLUMNS.units,
        Object.entries(master.units)
          .sort(([a], [b]) => byText(a, b))
          .map(([sat, kode]) => ({ sat, satuan_coretax: kode })),
      );
    case "settings":
      return JSON.stringify(master.settings, null, 2) + "\n";
    case "history":
      return toCsv(
        COLUMNS.history,
        master.history.map((h) => ({ nomor: h.number, tanggal_invoice: h.invoiceDate, pembeli: h.buyer, diekspor: h.exportedAt, file: h.file })),
      );
    default:
      throw new Error(`Data master tidak dikenal: ${key}`);
  }
}

export function upsertCustomer(master, customer) {
  const key = customerKey(customer.name);
  const existing = master.customers.find((c) => customerKey(c.name) === key);
  if (existing) Object.assign(existing, customer);
  else master.customers.push({ trxCode: "", ...customer });
}

export function removeCustomer(master, name) {
  const key = customerKey(name);
  master.customers = master.customers.filter((c) => customerKey(c.name) !== key);
}

export function updateItem(master, code, changes, name = "") {
  const current = master.items[code] ?? { name, coretaxCode: "", unit: "", opt: "" };
  master.items[code] = { ...current, name: current.name || name, ...changes };
}

const filled = (cells) => cells.map((c) => String(c ?? "").trim()).filter(Boolean);

/**
 * Baca data pelanggan hasil impor (baris dari file Excel/CSV atau tempelan): tiap baris berisi NPWP dan nama,
 * NITKU opsional, urutan kolom bebas. Baris judul sebelum data pertama dilewati.
 */
export function parseCustomerRows(rows) {
  const customers = [];
  const errors = [];
  let started = false;
  rows.forEach((row, i) => {
    const cells = filled(row);
    if (!cells.length) return;
    let npwp = null;
    let nitku = null;
    const names = [];
    for (const cell of cells) {
      const digits = cell.replace(/[\s.\-]/g, "");
      const numeric = /^\d+$/.test(digits);
      if (numeric && !npwp && (digits.length === 15 || digits.length === 16)) npwp = normalizeNpwp(digits);
      else if (numeric && !nitku && (digits.length === 21 || digits.length === 22)) nitku = normalizeNitku(digits);
      else names.push(cell);
    }
    if (!npwp) {
      if (started) errors.push(`Baris ${i + 1}: NPWP 16 digit tidak ditemukan`);
      return;
    }
    started = true;
    if (!names.length) return errors.push(`Baris ${i + 1}: nama pelanggan kosong`);
    customers.push({ name: names.join(" "), npwp, nitku: nitku ?? npwp + "000000" });
  });
  return { customers, errors };
}

/**
 * Baca data barang hasil impor: kolom pertama kode barang seperti di invoice, lalu kode Coretax 6 angka;
 * satuan Coretax (UM.xxxx) dan nama barang opsional. Baris judul sebelum data pertama dilewati.
 */
export function parseItemRows(rows) {
  const items = [];
  const errors = [];
  let started = false;
  rows.forEach((row, i) => {
    const [code, ...rest] = filled(row);
    if (!code) return;
    const coretaxCode = rest.find((c) => /^\d{6}$/.test(c));
    if (!coretaxCode) {
      if (started) errors.push(`Baris ${i + 1}: kode barang Coretax (6 angka) tidak ditemukan`);
      return;
    }
    started = true;
    const unit = rest.find((c) => /^UM\.\d{4}$/i.test(c))?.toUpperCase() ?? "";
    const name = rest.filter((c) => c !== coretaxCode && c.toUpperCase() !== unit).join(" ");
    items.push({ code, coretaxCode, unit, name });
  });
  return { items, errors };
}
