// Uji dengan file contoh asli. File contoh dan nilai yang diharapkan (contoh/harapan.json) berisi data pelanggan,
// jadi hanya ada di laptop: folder contoh/ tidak ikut di-upload, dan kode tes ini tidak boleh memuat data itu.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { computeFaktur } from "../src/calc.js";
import { parseInvoices } from "../src/parser.js";
import { extractPages } from "../src/pdf-text.js";
import { DEFAULT_UNITS } from "../src/satuan.js";
import { buildXml } from "../src/xml.js";

const file = (name) => new URL(`../contoh/${name}`, import.meta.url);
const expectations = existsSync(file("harapan.json")) ? JSON.parse(readFileSync(file("harapan.json"), "utf8")) : null;
const skip = !expectations && "contoh/harapan.json tidak ada";

async function readPdf(name) {
  return parseInvoices(await extractPages(pdfjs, new Uint8Array(readFileSync(file(name)))));
}

// Pembacaan XML sederhana (tanpa DOM parser), cukup untuk file contoh.
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
const blocks = (xml, name) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g")) ?? [];
const problems = (f) => f.checks.filter((c) => c.level === "error" || c.level === "warn").map((c) => c.message);

test("PDF contoh menghasilkan XML yang sama persis dengan buatan pengguna", { skip }, async () => {
  for (const { file: xmlName, pdfs } of expectations.xml) {
    const expected = readFileSync(file(xmlName));
    const xml = expected.toString("utf8");
    const invoices = [];
    for (const pdf of pdfs) invoices.push(...(await readPdf(pdf)).invoices);

    // NPWP pembeli dan kode barang Coretax adalah data master dari pengguna, jadi diambil dari XML contoh.
    // Satuan sengaja tidak diambil dari XML, supaya tabel padanan satuan ikut teruji.
    const master = { customers: [], items: {}, units: DEFAULT_UNITS };
    for (const block of blocks(xml, "TaxInvoice")) {
      const invoice = invoices.find((i) => i.number === tag(block, "RefDesc"));
      assert.ok(invoice, `invoice ${tag(block, "RefDesc")} tidak terbaca dari PDF`);
      master.customers.push({ name: invoice.buyerName, npwp: tag(block, "BuyerTin"), nitku: tag(block, "BuyerIDTKU") });
      blocks(block, "GoodService").forEach((gs, i) => {
        master.items[invoice.lines[i].code] = { coretaxCode: tag(gs, "Code") };
      });
    }

    const fakturs = invoices.map((invoice) => computeFaktur(invoice, master));
    for (const f of fakturs) assert.deepEqual(problems(f), [], f.number);

    const out = buildXml({ tin: tag(xml, "TIN"), idtku: tag(xml, "SellerIDTKU") }, fakturs);
    assert.equal(out, xml, xmlName);
    assert.ok(Buffer.from(out, "utf8").equals(expected), `isi byte ${xmlName} berbeda`);
  }
});

test("isi PDF contoh terbaca sesuai nilai yang sudah diperiksa", { skip }, async () => {
  for (const want of expectations.invoices) {
    const { invoices, warnings } = await readPdf(want.pdf);
    assert.deepEqual(warnings, [], want.pdf);
    const inv = invoices.find((i) => i.number === want.number);
    assert.ok(inv, `${want.number} tidak terbaca dari ${want.pdf}`);
    assert.deepEqual(
      {
        date: inv.date,
        buyerName: inv.buyerName,
        contact: inv.contact,
        poNumber: inv.poNumber,
        pages: inv.pages.map((p) => p.index),
        summary: inv.summary,
        lines: inv.lines.map((l) => [l.no, l.code, l.name, l.qty, l.unit, l.price, l.disc, l.total]),
      },
      {
        date: want.date,
        buyerName: want.buyerName,
        contact: want.contact,
        poNumber: want.poNumber,
        pages: want.pages,
        summary: want.summary,
        lines: want.lines,
      },
      want.number,
    );
    const f = computeFaktur(inv, { customers: [], items: {}, units: DEFAULT_UNITS });
    assert.equal(f.vatMode.mode, want.vatMode, want.number);
    assert.equal(f.totals.vatSen, want.vatSen, want.number);
    assert.equal(f.ready, false, "tanpa data master, faktur belum boleh siap");
  }
});

test("tanda bagian yang dibaca ada di halaman PDF yang benar, satu nomor per baris barang", { skip }, async () => {
  for (const want of expectations.invoices) {
    const inv = (await readPdf(want.pdf)).invoices.find((i) => i.number === want.number);
    const lines = inv.marks.filter((m) => m.kind === "line");
    assert.deepEqual([...new Set(lines.map((m) => m.label))], inv.lines.map((_, i) => String(i + 1)), want.number);
    assert.deepEqual(inv.marks.filter((m) => m.kind === "summary").map((m) => m.key).sort(), Object.keys(inv.summary).sort(), want.number);
    // Nomor invoice dan "Halaman X dari Y" dibaca di setiap halaman; data kop lainnya dari halaman pertama
    for (const key of ["number", "page"]) assert.deepEqual(inv.marks.filter((m) => m.key === key).map((m) => m.page), inv.pdfPages, `${want.number}: ${key}`);
    assert.ok(inv.marks.some((m) => m.key === "buyer" && m.page === inv.pdfPages[0]), `${want.number}: Kepada`);
    for (const m of inv.marks) {
      assert.ok(inv.pdfPages.includes(m.page), `${want.number}: halaman ${m.page}`);
      // Halaman invoice diputar, tampak mendatar 621 × 394 pt
      assert.ok(m.x0 >= 0 && m.x1 <= 622 && m.top >= 0 && m.bottom <= 395 && m.x0 < m.x1 && m.top < m.bottom, `${want.number}: ${JSON.stringify(m)}`);
    }
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].page === lines[i - 1].page) assert.ok(lines[i - 1].bottom <= lines[i].top + 0.5, `${want.number}: baris ${lines[i - 1].label} dan ${lines[i].label} bertumpuk`);
    }
  }
});
