// Uji pembaca .xlsx dengan file Excel kecil yang disusun di sini (arsip ZIP berisi XML).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCustomerRows } from "../src/master.js";
import { readXlsxRows } from "../src/xlsx.js";

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP minimal: [nama, isi, dikompres?]. Pembaca tidak memeriksa CRC, jadi CRC dibiarkan 0. */
async function makeZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text, compress] of files) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = compress ? await deflateRaw(raw) : raw;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, compress ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, compress ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, central.reduce((a, c) => a + c.length, 0), true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end]).arrayBuffer();
}

// Data uji buatan, bukan NPWP asli.
const fifteen = "1".repeat(15); // NPWP yang 0 di depannya hilang karena disimpan sebagai angka
const spaced = "2222 ".repeat(4).trim();

test("baca sheet pertama file Excel .xlsx", async () => {
  const file = await makeZip([
    ["[Content_Types].xml", "<Types/>", false],
    ["xl/workbook.xml", '<workbook xmlns:r="r"><sheets><sheet name="Pelanggan" sheetId="1" r:id="rId7"/></sheets></workbook>', false],
    ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId7" Type="worksheet" Target="worksheets/data.xml"/></Relationships>', false],
    ["xl/sharedStrings.xml", "<sst><si><t>NPWP</t></si><si><t>Nama</t></si><si><r><t xml:space=\"preserve\">PT A </t></r><r><rPr><b/></rPr><t>&amp; B</t></r></si></sst>", true],
    [
      "xl/worksheets/data.xml",
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        `<row r="3"><c r="A3"><v>${fifteen}</v></c><c r="B3" t="s"><v>2</v></c></row>` +
        `<row r="4"><c r="A4" t="inlineStr"><is><t>${spaced}</t></is></c><c r="C4" t="str"><v>CV TIGA</v></c></row>` +
        '<row r="5"><c r="A5"><v>1.11111111111111E+14</v></c><c r="B5" t="inlineStr"><is><t>PT EMPAT</t></is></c><c r="C5" s="2"/></row>' +
        '<row r="6"><c r="B6" t="inlineStr"><is><t>PT LIMA</t></is></c></row>' +
        "</sheetData></worksheet>",
      true,
    ],
  ]);

  const rows = await readXlsxRows(file);
  assert.deepEqual(rows, [
    ["NPWP", "Nama"],
    [],
    [fifteen, "PT A & B"],
    [spaced, "", "CV TIGA"],
    [fifteen, "PT EMPAT", ""],
    ["", "PT LIMA"],
  ]);

  const { customers, errors } = parseCustomerRows(rows);
  assert.deepEqual(customers.map((c) => [c.name, c.npwp]), [
    ["PT A & B", "0" + fifteen],
    ["CV TIGA", spaced.replace(/ /g, "")],
    ["PT EMPAT", "0" + fifteen],
  ]);
  assert.deepEqual(errors, ["Baris 6: NPWP 16 digit tidak ditemukan"]); // nomor baris sesuai Excel
});

test("file yang bukan .xlsx ditolak dengan pesan jelas", async () => {
  await assert.rejects(readXlsxRows(new TextEncoder().encode("bukan excel").buffer), /bukan file Excel/);
});
