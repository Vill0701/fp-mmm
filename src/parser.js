// Membaca PDF "SALES INVOICE" (format invoice penjualan yang dipakai penjual) dari teks PDF (hasil extractPages).
// Pembacaan memakai posisi teks di halaman, bukan urutan teks di dalam file, karena urutan itu
// tidak selalu sama dengan urutan visual (misalnya nama barang yang turun ke baris kedua).

const TOL = 2; // toleransi posisi, dalam pt

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MEI: 5, MAY: 5, JUN: 6, JUL: 7, AGU: 8, AGS: 8, AGT: 8,
  AUG: 8, SEP: 9, OKT: 10, OCT: 10, NOV: 11, DES: 12, DEC: 12,
};

// Kolom tabel barang: tiga kolom pertama rata kiri, sisanya rata kanan terhadap judul kolomnya.
const LEFT_COLUMNS = { no: "No", code: "Kode Barang", name: "Nama Barang" };
const RIGHT_COLUMNS = { qty: "Qty", unit: "Sat", price: "@Harga", disc: "Disc", total: "Total Harga" };

const SUMMARY_LABELS = {
  "Sub Total": "subTotal",
  Discount: "discount",
  PPN: "ppn",
  "Biaya Kirim": "shipping",
  Total: "total",
};

/** "2,100,000" → 2100000. Invoice memakai koma sebagai pemisah ribuan dan titik untuk desimal. */
export function parseNumber(str) {
  const s = str.trim();
  return /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) ? Number(s.replace(/,/g, "")) : null;
}

/** "30 Okt 2026" → "2026-10-30" */
export function parseDate(str) {
  const m = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/.exec(str.trim());
  const month = m && MONTHS[m[2].slice(0, 3).toUpperCase()];
  return month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

const sameLine = (a, b) => Math.abs(a.y - b.y) <= TOL;

const DEFAULT_H = 8; // tinggi huruf (pt) kalau tidak diketahui

/**
 * Kotak (pt, koordinat halaman yang tampak) yang menutupi teks-teks yang dibaca, untuk ditandai saat PDF
 * ditampilkan di aplikasi: dari atas huruf sampai sedikit di bawah garis dasarnya.
 */
function boxOf(...list) {
  const its = list.filter(Boolean);
  if (!its.length) return null;
  const h = (it) => it.h || DEFAULT_H;
  return {
    x0: Math.min(...its.map((it) => it.x)),
    x1: Math.max(...its.map((it) => it.x + it.w)),
    top: Math.min(...its.map((it) => it.y - 0.85 * h(it))),
    bottom: Math.max(...its.map((it) => it.y + 0.3 * h(it))),
  };
}

const mergeBoxes = (a, b) =>
  !a || !b ? a ?? b : { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };

/** Teks terdekat di kanan label pada baris yang sama, melewati tanda ":". */
function valueRightOf(items, label, maxX = Infinity) {
  const start = label.x + label.w;
  return (
    items
      .filter((it) => it.str !== ":" && sameLine(it, label) && it.x > start && it.x < maxX)
      .sort((a, b) => a.x - b.x)[0] ?? null
  );
}

/** Lanjutan teks yang turun ke baris berikutnya, tepat di bawah `first` dan di atas posisi `untilY`. */
function linesBelow(items, first, untilY) {
  return items
    .filter((it) => Math.abs(it.x - first.x) <= TOL && it.y > first.y + TOL && it.y < untilY - TOL)
    .sort((a, b) => a.y - b.y);
}

/** "PO/ABC-" + "XY/2026" digabung tanpa spasi; potongan biasa digabung dengan spasi. */
function joinWrapped(parts) {
  return parts.reduce((acc, p) => (!acc ? p : /[/-]$/.test(acc) ? acc + p : `${acc} ${p}`), "");
}

function findTableHeader(items) {
  const no = items.find((it) => it.str === "No" && items.some((o) => o.str === "Kode Barang" && sameLine(o, it)));
  if (!no) return null;
  const cols = {};
  for (const [key, text] of Object.entries({ ...LEFT_COLUMNS, ...RIGHT_COLUMNS })) {
    const it = items.find((o) => o.str === text && sameLine(o, no));
    if (!it) return null;
    cols[key] = { x: it.x, right: it.x + it.w };
  }
  return { y: no.y, cols };
}

function columnOf(it, cols) {
  for (const key of Object.keys(LEFT_COLUMNS)) if (Math.abs(it.x - cols[key].x) <= TOL) return key;
  const right = it.x + it.w;
  for (const key of Object.keys(RIGHT_COLUMNS)) if (Math.abs(right - cols[key].right) <= TOL) return key;
  return null;
}

function makeRow(cells, warnings) {
  const row = {
    no: Number(cells.no),
    code: cells.code ?? "",
    name: cells.name ?? "",
    qty: parseNumber(cells.qty ?? ""),
    unit: cells.unit ?? "",
    price: parseNumber(cells.price ?? ""),
    disc: cells.disc ?? "",
    total: parseNumber(cells.total ?? ""),
  };
  for (const [key, label] of [["qty", "Qty"], ["price", "@Harga"], ["total", "Total Harga"]]) {
    if (row[key] == null) warnings.push(`baris ${row.no}: kolom ${label} tidak terbaca ("${cells[key] ?? ""}")`);
  }
  return row;
}

function parseRows(items, header, bottomY, warnings) {
  const body = items
    .filter((it) => it.y > header.y + TOL && it.y < bottomY - TOL)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // Kelompokkan per baris visual. Kolom Sat dan Disc letaknya sedikit lebih rendah (±1 pt).
  const lines = [];
  for (const it of body) {
    const last = lines.at(-1);
    if (last && it.y - last.y <= TOL + 0.5) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }

  const rows = [];
  for (const line of lines) {
    const cells = {};
    for (const it of line.items) {
      const col = columnOf(it, header.cols);
      if (!col) {
        warnings.push(`teks di luar kolom tabel: "${it.str}"`);
        continue;
      }
      cells[col] = cells[col] ? `${cells[col]} ${it.str}` : it.str;
    }
    const filled = Object.keys(cells);
    const box = boxOf(...line.items);
    if (/^\d+$/.test(cells.no ?? "")) rows.push({ ...makeRow(cells, warnings), box });
    else if (filled.length === 1 && cells.name) rows.push({ continuation: cells.name, box });
    else if (filled.length) warnings.push(`baris tabel tidak dikenali: "${line.items.map((it) => it.str).join(" ")}"`);
  }
  return rows;
}

function parseSummary(items, boxes) {
  const summary = {};
  for (const [text, key] of Object.entries(SUMMARY_LABELS)) {
    const label = items.find((it) => it.str === text);
    if (!label) continue;
    const value = items
      .filter((it) => it.x > label.x + label.w && Math.abs(it.y - label.y) <= 3 && parseNumber(it.str) != null)
      .sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y))[0];
    if (value) {
      summary[key] = parseNumber(value.str);
      boxes[key] = boxOf(label, value);
    }
  }
  return Object.keys(summary).length ? summary : null;
}

function parsePage(page) {
  const { items } = page;
  const find = (text) => items.find((it) => it.str === text) ?? null;
  const warnings = [];
  const header = findTableHeader(items);
  const rightBlockX = find("SALES INVOICE")?.x ?? Infinity; // blok Kepada/Kontak ada di kiri blok ini

  const numberLabel = find("Nomor");
  const dateLabel = find("Tgl Faktur");
  const buyerLabel = find("Kepada");
  const contactLabel = find("Kontak");
  const poLabel = find("No Po");
  // Posisi teks kop yang dibaca, untuk ditandai saat PDF ditampilkan di aplikasi
  const marks = {};

  const numberValue = numberLabel && valueRightOf(items, numberLabel);
  marks.number = numberLabel && boxOf(numberLabel, numberValue);

  const dateValue = dateLabel && valueRightOf(items, dateLabel);
  const dateText = dateValue?.str;
  const date = dateText ? parseDate(dateText) : null;
  if (dateText && !date) warnings.push(`tanggal tidak terbaca: "${dateText}"`);
  marks.date = dateLabel && boxOf(dateLabel, dateValue);

  let buyerName = "";
  const buyerFirst = buyerLabel && valueRightOf(items, buyerLabel, rightBlockX);
  if (buyerFirst) {
    const untilY = contactLabel?.y ?? header?.y ?? Infinity;
    const buyerItems = [buyerFirst, ...linesBelow(items, buyerFirst, untilY)];
    buyerName = buyerItems.map((it) => it.str).join(" ");
    marks.buyer = boxOf(buyerLabel, ...buyerItems);
  }

  const contactValue = contactLabel && valueRightOf(items, contactLabel, rightBlockX);
  marks.contact = contactLabel && boxOf(contactLabel, contactValue);

  let poNumber = "";
  const poFirst = poLabel && valueRightOf(items, poLabel);
  if (poFirst) {
    const untilY = header?.y ?? poFirst.y + 30;
    const poItems = [poFirst, ...linesBelow(items, poFirst, untilY)];
    poNumber = joinWrapped(poItems.map((it) => it.str));
    marks.po = boxOf(poLabel, ...poItems);
  }

  const pageItem = items.find((it) => /^Halaman\s+(\d+)\s+dari\s+(\d+)$/i.test(it.str));
  const pageInfo = pageItem && /^Halaman\s+(\d+)\s+dari\s+(\d+)$/i.exec(pageItem.str);
  marks.page = boxOf(pageItem);
  const summaryTop = find("Sub Total")?.y ?? Infinity;
  const summaryMarks = {};

  return {
    number: numberValue?.str || "",
    date,
    buyerName,
    contact: contactValue?.str || "",
    poNumber,
    page: pageInfo ? { index: Number(pageInfo[1]), of: Number(pageInfo[2]) } : null,
    pdfPage: page.number, // nomor halaman di file PDF (beda dengan "Halaman X dari Y" yang tercetak)
    rows: header ? parseRows(items, header, summaryTop, warnings) : [],
    summary: parseSummary(items, summaryMarks),
    marks,
    summaryMarks,
    warnings,
  };
}

/**
 * Ubah halaman-halaman PDF menjadi daftar invoice. Satu PDF boleh berisi beberapa invoice;
 * halaman dikelompokkan menurut nomor invoice lalu diurutkan menurut "Halaman X dari Y".
 */
export function parseInvoices(pages) {
  const warnings = [];
  const groups = new Map();
  for (const page of pages) {
    const parsed = parsePage(page);
    if (!parsed.number) {
      warnings.push(`Halaman ${page.number} dilewati: nomor invoice tidak ditemukan`);
      continue;
    }
    if (!groups.has(parsed.number)) groups.set(parsed.number, []);
    groups.get(parsed.number).push(parsed);
  }

  const invoices = [];
  for (const [number, parts] of groups) {
    parts.sort((a, b) => (a.page?.index ?? 0) - (b.page?.index ?? 0));
    const first = parts[0];
    // Kotak teks yang dibaca: { page (halaman PDF), kind: header | line | summary, key/label, x0, x1, top, bottom } dalam pt
    const marks = [];
    const mark = (page, kind, box, extra) => box && marks.push({ page, kind, ...extra, ...box });
    for (const key of ["date", "buyer", "contact", "po"]) mark(first.pdfPage, "header", first.marks[key], { key }); // dari halaman pertama
    const invoice = {
      number,
      date: first.date,
      buyerName: first.buyerName,
      contact: first.contact,
      poNumber: first.poNumber,
      pages: [],
      pdfPages: [],
      lines: [],
      summary: null,
      warnings: [],
      marks,
    };
    for (const part of parts) {
      const where = `Hal. ${part.page?.index ?? "?"}`;
      if (part.page) invoice.pages.push(part.page);
      invoice.pdfPages.push(part.pdfPage);
      mark(part.pdfPage, "header", part.marks.number, { key: "number" });
      mark(part.pdfPage, "header", part.marks.page, { key: "page" });
      for (const { box, ...row } of part.rows) {
        if (!row.continuation) {
          invoice.lines.push(row);
          mark(part.pdfPage, "line", box, { label: String(invoice.lines.length) });
        } else if (invoice.lines.length) {
          invoice.lines.at(-1).name += ` ${row.continuation}`;
          // Lanjutan nama di halaman yang sama ikut kotak barisnya; di halaman lain diberi tanda bernomor sama
          const last = marks.findLast((m) => m.kind === "line");
          if (last?.page === part.pdfPage) Object.assign(last, mergeBoxes(last, box));
          else mark(part.pdfPage, "line", box, { label: String(invoice.lines.length) });
        } else invoice.warnings.push(`${where}: lanjutan nama barang tanpa baris sebelumnya: "${row.continuation}"`);
      }
      if (part.summary) {
        invoice.summary = part.summary;
        for (const [key, box] of Object.entries(part.summaryMarks)) mark(part.pdfPage, "summary", box, { key });
      }
      invoice.warnings.push(...part.warnings.map((w) => `${where}: ${w}`));
    }
    for (const line of invoice.lines) line.name = line.name.replace(/\s+/g, " ").trim();
    invoices.push(invoice);
  }
  return { invoices, warnings };
}
