// Membaca sheet pertama file Excel (.xlsx) menjadi baris-baris berisi teks, tanpa library tambahan.
// File .xlsx adalah arsip ZIP berisi XML; isinya dibuka dengan DecompressionStream bawaan browser.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("bukan file Excel .xlsx yang valid");
  const entries = new Map();
  let p = u32(bytes, end + 16);
  for (let n = u16(bytes, end + 10); n > 0; n--) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("file Excel rusak");
    const nameLength = u16(bytes, p + 28);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    entries.set(name, { method: u16(bytes, p + 10), size: u32(bytes, p + 20), offset: u32(bytes, p + 42) });
    p += 46 + nameLength + u16(bytes, p + 30) + u16(bytes, p + 32);
  }
  return entries;
}

async function readEntry(bytes, entry) {
  const start = entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error("format kompresi file Excel tidak didukung");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()],
  );

// Tag boleh memakai awalan namespace (mis. <x:row>) tergantung aplikasi pembuat filenya.
const texts = (xml) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(([, t]) => decode(t)).join("");
const columnIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Angka besar kadang tersimpan sebagai "8.23637178413E+14"; ubah ke digit biasa. */
function numberText(value) {
  if (!/^-?\d+(\.\d+)?E[+-]?\d+$/i.test(value)) return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? String(n) : value;
}

export async function readXlsxRows(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = zipEntries(bytes);
  const read = async (name) => (entries.has(name) ? readEntry(bytes, entries.get(name)) : "");

  // Sheet pertama menurut urutan di workbook.xml, ditemukan lewat file relasinya.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const relId = /<(?:\w+:)?sheet\b[^>]*\b\w+:id="([^"]+)"/.exec(await read("xl/workbook.xml"))?.[1];
  for (const [tag] of (await read("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)) {
    if (relId && tag.includes(`Id="${relId}"`)) {
      const target = /Target="([^"]+)"/.exec(tag)?.[1] ?? "";
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    }
  }
  if (!entries.has(sheetPath)) throw new Error("sheet tidak ditemukan di file Excel");

  const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(([, si]) => texts(si));
  const rows = [];
  for (const [, rowAttrs, body] of (await read(sheetPath)).matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row = [];
    for (const [, attrs, inner = ""] of body.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const raw = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = texts(inner);
      else if (raw != null) value = decode(raw);
      if (!type || type === "n") value = numberText(value);
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      row[ref ? columnIndex(ref) : row.length] = value;
    }
    // Nomor baris Excel dipertahankan supaya pesan "Baris N" sesuai dengan yang terlihat di Excel.
    const number = Number(/\br="(\d+)"/.exec(rowAttrs)?.[1]) || rows.length + 1;
    rows[number - 1] = Array.from(row, (cell) => cell ?? "");
  }
  return Array.from(rows, (row) => row ?? []);
}
