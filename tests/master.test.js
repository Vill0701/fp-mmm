import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, toCsv } from "../src/csv.js";
import * as M from "../src/master.js";

// Data uji buatan, bukan NPWP asli.
const npwpA = "0" + "1".repeat(15);
const npwpB = "2".repeat(16);

test("CSV: tanda kutip, koma, dan baris baru", () => {
  const records = [{ nama: 'PT "MAJU", Tbk.', npwp: npwpA }, { nama: "CV BARU\nJAYA", npwp: npwpB }];
  const text = toCsv(["nama", "npwp"], records);
  assert.deepEqual(parseCsv(text), records);
  assert.deepEqual(parseCsv("﻿nama,npwp\r\nA,1\r\n\r\n"), [{ nama: "A", npwp: "1" }]);
});

test("NPWP dan NITKU dirapikan", () => {
  assert.equal(M.normalizeNpwp(npwpA.slice(1)), npwpA); // 0 di depan hilang (Excel) atau format lama 15 digit
  assert.equal(M.normalizeNpwp(npwpB.replace(/(\d{4})/g, "$1 ")), npwpB);
  assert.equal(M.normalizeNpwp("123"), null);
  assert.equal(M.normalizeNitku("", npwpB), npwpB + "000000");
  assert.equal(M.normalizeNitku((npwpA + "000001").slice(1)), npwpA + "000001"); // 0 di depan hilang
  assert.equal(M.normalizeNitku("12345"), null);
});

test("data master: baca, ubah, dan tulis ulang", () => {
  const master = M.parseMaster({
    customers: toCsv(["nama", "npwp", "nitku", "kode_transaksi"], [{ nama: "PT CONTOH", npwp: npwpA.slice(1), nitku: "", kode_transaksi: "" }]),
    units: "sat,satuan_coretax\nPACK,UM.0033\n",
    settings: JSON.stringify({ npwpPenjual: npwpB }),
  });
  assert.deepEqual(master.customers, [{ name: "PT CONTOH", npwp: npwpA, nitku: npwpA + "000000", trxCode: "" }]);
  assert.equal(master.units.PACK, "UM.0033");
  assert.equal(master.units.PCS, "UM.0021"); // padanan bawaan tetap ada
  assert.equal(master.settings.npwpPenjual, npwpB);
  assert.equal(master.settings.kodeTransaksi, "04");

  M.upsertCustomer(master, { name: "pt. contoh", npwp: npwpB, nitku: npwpB + "000000" }); // nama sama, beda tulisan
  assert.equal(master.customers.length, 1);
  assert.equal(master.customers[0].npwp, npwpB);
  M.updateItem(master, "ITM-1", { coretaxCode: "731800" }, "BAUT");
  M.updateItem(master, "ITM-1", { unit: "UM.0021" });
  assert.deepEqual(master.items["ITM-1"], { name: "BAUT", coretaxCode: "731800", unit: "UM.0021", opt: "" });

  const again = M.parseMaster(Object.fromEntries(Object.keys(M.FILES).map((key) => [key, M.serializeMaster(master, key)])));
  assert.deepEqual(again, master);
});

test("tempel pelanggan dari Excel", () => {
  const spaced = npwpA.replace(/(\d{4})/g, "$1 ").trim();
  const text = [
    "NPWP\tNama",
    `${spaced}\t\tCV CONTOH ABADI`,
    `PT DUA;${npwpB};${npwpB}000001`,
    "123\tPT SALAH",
    `${npwpB}`,
  ].join("\n");
  const { customers, errors } = M.parsePastedCustomers(text);
  assert.deepEqual(customers, [
    { name: "CV CONTOH ABADI", npwp: npwpA, nitku: npwpA + "000000" },
    { name: "PT DUA", npwp: npwpB, nitku: npwpB + "000001" },
  ]);
  assert.deepEqual(errors, ["Baris 4: NPWP 16 digit tidak ditemukan", "Baris 5: nama pelanggan kosong"]);
});
