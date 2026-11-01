// Semua nilai uang dihitung dalam sen (bilangan bulat) supaya tidak ada galat pembulatan desimal.

export const toSen = (n) => Math.round(n * 100);

/** round(a × b ÷ c) dengan pembulatan setengah ke atas, dihitung eksak (BigInt). a, b, c bilangan bulat. */
export function mulDiv(a, b, c) {
  let n = BigInt(a) * BigInt(b);
  let d = BigInt(c);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  if (negative) n = -n;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return Number(negative ? -q : q);
}

/** Angka untuk XML: tanpa desimal kalau bulat, selain itu maksimal 2 desimal (9166.67, 123.5). */
export function formatSen(sen) {
  const abs = Math.abs(sen);
  const frac = abs % 100;
  let s = String(Math.floor(abs / 100));
  if (frac) s += "." + String(frac).padStart(2, "0").replace(/0$/, "");
  return (sen < 0 ? "-" : "") + s;
}

export const formatQty = (qty) => String(Number(qty.toFixed(4)));

/** Untuk pesan ke pengguna: "Rp 3.170.000". */
export const rupiah = (sen) => "Rp " + (sen / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 });
