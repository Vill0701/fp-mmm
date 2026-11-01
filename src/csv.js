// CSV sederhana (RFC 4180): pemisah koma; nilai yang berisi koma, kutip, atau baris baru diberi tanda kutip.
// Dipakai untuk file data master di repo private, supaya tampil sebagai tabel di GitHub.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);

  const [header = [], ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const keys = header.map((k) => k.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function toCsv(columns, records) {
  const escape = (value) => {
    const s = String(value ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...records.map((r) => columns.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}
