// Tampilan aplikasi: buka data master (PIN), baca PDF invoice, cek & lengkapi, lalu buat XML Coretax.
// Semua teks dari PDF dan data master dimasukkan sebagai teks biasa (bukan HTML).
import * as pdfjs from "../vendor/pdfjs/pdf.min.js";
import { computeFaktur, customerKey } from "../src/calc.js";
import * as M from "../src/master.js";
import { parseInvoices } from "../src/parser.js";
import { extractPages } from "../src/pdf-text.js";
import { normalizeUnit, TRX_CODES, UNIT_NAMES } from "../src/satuan.js";
import { fold, guessQuery, searchCodes, words } from "../src/search.js";
import { buildXml } from "../src/xml.js";
import { GitHubStore, MemoryStore } from "./storage.js";
import { seal, unseal, WrongPinError } from "./vault.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

const LOCAL_KEY = "fp-mmm";
const MAX_PIN_TRIES = 5;
const IDLE_LOCK_MS = 15 * 60 * 1000;
const DEMO = new URLSearchParams(location.search).has("coba");
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

const app = document.getElementById("app");
const state = {
  local: readLocal(), // { owner, repo, sealed, failed } — token di sini selalu terenkripsi
  store: null,
  master: null,
  shas: {},
  dirty: new Set(),
  saving: false,
  saveError: "",
  invoices: [],
  fakturs: [],
  view: "main",
  tab: "customers",
  query: "",
  filename: "",
  importErrors: [],
  open: {},
  lastActivity: Date.now(),
};

// ---------- utilitas ----------

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state.local));
}

function forgetDevice() {
  localStorage.removeItem(LOCAL_KEY);
  state.local = {};
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
const num = (sen) => (sen / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 });
const qtyText = (qty) => qty.toLocaleString("id-ID", { maximumFractionDigits: 4 });
const dateText = (iso) => (iso ? iso.split("-").reverse().join("-") : "tanggal ?");
const mask = (digits) => (digits ? `•••• ${String(digits).slice(-4)}` : "");
const byName = (a, b) => a.name.localeCompare(b.name, "id");
const isCode = (code) => /^\d{6}$/.test(code);
const isUnit = (unit) => /^UM\.\d{4}$/.test(unit);

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultFilename() {
  const d = new Date();
  const parts = { DD: pad(d.getDate()), MM: pad(d.getMonth() + 1), YYYY: String(d.getFullYear()) };
  const pattern = state.master.settings.namaFile || M.DEFAULT_MASTER_SETTINGS.namaFile;
  return pattern.replace(/\{(DD|MM|YYYY)\}/g, (_, key) => parts[key]);
}

function toast(message, level = "info") {
  for (const old of document.querySelectorAll(".toast")) old.remove();
  const el = h("div", { class: `toast ${level}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

function busy(text) {
  let el = document.getElementById("busy");
  if (!text) return el?.remove();
  if (!el) document.body.append((el = h("div", { id: "busy", role: "status" })));
  el.textContent = text;
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint && h("small", {}, hint));
}

function formError(form, message) {
  const el = form.querySelector(".error");
  el.textContent = message;
  el.hidden = !message;
}

const formData = (form) => Object.fromEntries(new FormData(form));
const pinInput = (name, autocomplete = "new-password") =>
  h("input", { name, type: "password", inputmode: "numeric", autocomplete, required: true });

function unitSelect({ name, value = "", onChange, invalid = false, emptyLabel = "Pilih satuan…" }) {
  return h(
    "select",
    { name, class: invalid ? "invalid" : "", "aria-label": "Satuan Coretax", onchange: onChange && ((e) => onChange(e.target.value)) },
    h("option", { value: "" }, emptyLabel),
    Object.entries(UNIT_NAMES).map(([code, label]) => h("option", { value: code, selected: code === value }, `${label} (${code})`)),
  );
}

function trxSelect(name, value, emptyLabel) {
  return h(
    "select",
    { name },
    emptyLabel && h("option", { value: "" }, emptyLabel),
    Object.entries(TRX_CODES).map(([code, label]) => h("option", { value: code, selected: code === value }, `${code} - ${label}`)),
  );
}

function details(key, defaultOpen, summary, ...content) {
  return h(
    "details",
    { open: state.open[key] ?? defaultOpen, ontoggle: (e) => (state.open[key] = e.target.open) },
    h("summary", {}, summary),
    ...content,
  );
}

// ---------- mulai, PIN, dan koneksi ----------

function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  addEventListener("beforeunload", (e) => {
    if (state.dirty.size) e.preventDefault();
  });
  for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => (state.lastActivity = Date.now()), { passive: true });
  setInterval(checkIdle, 30 * 1000);
  document.addEventListener("visibilitychange", checkIdle);

  if (DEMO) return connect(new MemoryStore()).catch((err) => toast(err.message, "error"));
  if (state.local.sealed) showUnlock();
  else showSetup();
}

function showSetup(message = "") {
  const form = h(
    "form",
    {
      class: "card narrow",
      onsubmit: async (e) => {
        e.preventDefault();
        const d = formData(form);
        if (!/^\d{6,}$/.test(d.pin) || d.pin !== d.pin2) return formError(form, "PIN minimal 6 angka dan kedua isian harus sama.");
        busy("Menghubungkan ke GitHub…");
        try {
          const store = new GitHubStore({ owner: d.owner.trim(), repo: d.repo.trim(), token: d.token.trim() });
          await store.check();
          state.local = { owner: store.owner, repo: store.repo, sealed: await seal(store.token, d.pin), failed: 0 };
          writeLocal();
          await connect(store);
        } catch (err) {
          busy();
          formError(form, err.message);
        }
      },
    },
    h("h1", {}, "Hubungkan data master"),
    message && h("p", { class: "notice" }, message),
    h("p", { class: "muted" }, "Data master (NPWP pelanggan) disimpan di repo GitHub private milikmu. Token hanya disimpan di perangkat ini dalam keadaan terkunci PIN."),
    field("Pemilik repo", h("input", { name: "owner", value: "vill0701", required: true, autocapitalize: "off", spellcheck: "false" })),
    field("Nama repo data (harus private)", h("input", { name: "repo", value: "fp-mmm-data", required: true, autocapitalize: "off", spellcheck: "false" })),
    field("Token GitHub", h("input", { name: "token", type: "password", required: true, autocomplete: "off" })),
    details(
      "token-help",
      false,
      "Cara membuat token",
      h(
        "ol",
        {},
        h("li", {}, "Buka ", h("a", { href: TOKEN_URL, target: "_blank", rel: "noopener noreferrer" }, "halaman token GitHub"), "."),
        h("li", {}, "Repository access: Only select repositories, pilih repo data."),
        h("li", {}, "Permissions → Contents: Read and write."),
        h("li", {}, "Generate token, salin, lalu tempel di atas."),
      ),
    ),
    field("PIN baru (minimal 6 angka)", pinInput("pin")),
    field("Ulangi PIN", pinInput("pin2")),
    h("p", { class: "error", hidden: true }),
    h("button", { type: "submit" }, "Hubungkan"),
    h("p", { class: "muted" }, "Ingin melihat cara kerjanya dulu? ", h("a", { href: "?coba" }, "Buka mode coba"), " (data tidak disimpan)."),
  );
  app.replaceChildren(form);
}

function showUnlock(message = "") {
  const form = h(
    "form",
    {
      class: "card narrow",
      onsubmit: async (e) => {
        e.preventDefault();
        busy("Membuka…");
        try {
          const token = await unseal(state.local.sealed, formData(form).pin);
          state.local.failed = 0;
          writeLocal();
          await connect(new GitHubStore({ owner: state.local.owner, repo: state.local.repo, token }));
        } catch (err) {
          busy();
          if (!(err instanceof WrongPinError)) return formError(form, err.message);
          state.local.failed = (state.local.failed ?? 0) + 1;
          if (state.local.failed >= MAX_PIN_TRIES) {
            forgetDevice();
            return showSetup("PIN salah 5 kali. Demi keamanan, token dihapus dari perangkat ini. Masukkan token lagi.");
          }
          writeLocal();
          form.reset();
          formError(form, `PIN salah. Sisa ${MAX_PIN_TRIES - state.local.failed} kali percobaan.`);
        }
      },
    },
    h("h1", {}, "FP MMM"),
    h("p", {}, "Masukkan PIN untuk membuka data master."),
    message && h("p", { class: "notice" }, message),
    field("PIN", pinInput("pin", "current-password")),
    h("p", { class: "error", hidden: true }),
    h("button", { type: "submit" }, "Buka"),
    h(
      "button",
      {
        type: "button",
        class: "link",
        onclick: () => {
          if (!confirm("Hubungkan ulang dengan token? Token yang tersimpan di perangkat ini akan dihapus.")) return;
          forgetDevice();
          showSetup();
        },
      },
      "Lupa PIN / ganti token",
    ),
  );
  app.replaceChildren(form);
  form.querySelector("input").focus();
}

async function connect(store) {
  busy("Memuat data master…");
  try {
    const keys = Object.keys(M.FILES);
    const files = await Promise.all(keys.map((key) => store.read(M.FILES[key])));
    const texts = {};
    state.shas = {};
    state.dirty.clear();
    keys.forEach((key, i) => {
      if (files[i]) {
        texts[key] = files[i].text;
        state.shas[key] = files[i].sha;
      } else state.dirty.add(key); // file yang belum ada dibuat sekali
    });
    state.master = M.parseMaster(texts);
    state.store = store;
  } finally {
    busy();
  }
  state.lastActivity = Date.now();
  if (state.dirty.size) scheduleSave(0);
  if (!M.normalizeNpwp(state.master.settings.npwpPenjual)) {
    state.view = "master";
    state.tab = "settings";
  }
  render();
}

function checkIdle() {
  if (!DEMO && state.master && Date.now() - state.lastActivity > IDLE_LOCK_MS) lock(true);
}

async function lock(auto = false) {
  if (!state.master) return;
  if (state.dirty.size) await saveNow();
  if (state.dirty.size) {
    if (auto) return; // jangan mengunci otomatis kalau masih ada perubahan yang gagal disimpan
    if (!confirm("Ada perubahan data master yang belum tersimpan. Tetap kunci?")) return;
  }
  Object.assign(state, { store: null, master: null, shas: {}, invoices: [], fakturs: [], view: "main", filename: "" });
  state.dirty.clear();
  showUnlock(auto ? "Aplikasi dikunci otomatis karena lama tidak dipakai." : "");
}

// ---------- menyimpan data master ----------

let saveTimer = 0;

function markDirty(key) {
  state.dirty.add(key);
  scheduleSave();
}

function scheduleSave(delay = 1200) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
  renderStatus();
}

async function saveNow() {
  if (state.saving || !state.store) return;
  clearTimeout(saveTimer);
  state.saving = true;
  state.saveError = "";
  renderStatus();
  try {
    for (const key of [...state.dirty]) {
      state.dirty.delete(key); // perubahan baru selama menyimpan akan menandai ulang
      try {
        await writeFile(key);
      } catch (err) {
        state.dirty.add(key);
        throw err;
      }
    }
  } catch (err) {
    state.saveError = err.message;
  } finally {
    state.saving = false;
    renderStatus();
    if (state.dirty.size && !state.saveError) scheduleSave();
  }
}

async function writeFile(key) {
  const path = M.FILES[key];
  const message = `Perbarui ${path}`;
  try {
    state.shas[key] = await state.store.write(path, M.serializeMaster(state.master, key), state.shas[key], message);
  } catch (err) {
    if (err.status !== 409) throw err;
    // File diubah dari perangkat lain: ambil versi terbaru, gabungkan, lalu simpan lagi.
    const remote = await state.store.read(path);
    mergeRemote(key, remote?.text ?? "");
    state.shas[key] = await state.store.write(path, M.serializeMaster(state.master, key), remote?.sha, message);
  }
}

function mergeRemote(key, text) {
  const remote = M.parseMaster({ [key]: text });
  const m = state.master;
  if (key === "customers") {
    for (const c of remote.customers) if (!m.customers.some((x) => customerKey(x.name) === customerKey(c.name))) m.customers.push(c);
  } else if (key === "items") m.items = { ...remote.items, ...m.items };
  else if (key === "units") m.units = { ...remote.units, ...m.units };
  else if (key === "history") {
    for (const r of remote.history) if (!m.history.some((x) => x.number === r.number && x.exportedAt === r.exportedAt)) m.history.push(r);
  }
}

function renderStatus() {
  const el = document.getElementById("save-status");
  if (!el) return;
  let level = "ok";
  let text = `Data master tersimpan di ${state.store?.label ?? ""}`;
  if (DEMO) [level, text] = ["warn", "Mode coba: data tidak disimpan dan hilang saat halaman ditutup"];
  else if (state.saveError) [level, text] = ["error", `Gagal menyimpan: ${state.saveError}`];
  else if (state.saving || state.dirty.size) [level, text] = ["info", "Menyimpan data master…"];
  el.className = `save-status ${level}`;
  el.replaceChildren(text, state.saveError ? h("button", { class: "link", onclick: saveNow }, "Coba lagi") : "");
}

// ---------- tampilan utama ----------

function computeSettings() {
  const s = state.master.settings;
  return { trxCode: s.kodeTransaksi || "04", inclusiveRounding: s.pembulatanHargaInclude === "rupiah" ? "rupiah" : "sen" };
}

function computeAll() {
  const settings = computeSettings();
  state.fakturs = state.invoices.map((invoice) => {
    const f = computeFaktur(invoice, state.master, settings);
    const done = state.master.history.filter((r) => r.number === invoice.number).at(-1);
    if (done) f.checks.push({ level: "warn", message: `Sudah pernah dibuatkan XML pada ${done.exportedAt} (${done.file})` });
    return f;
  });
}

function render() {
  if (!state.master) return;
  computeAll();
  const y = scrollY;
  app.replaceChildren(topBar(), state.view === "master" ? masterView() : mainView());
  renderStatus();
  scrollTo(0, y);
}

function go(view) {
  state.view = view;
  state.query = "";
  render();
  scrollTo(0, 0);
}

function topBar() {
  return h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("strong", {}, "FP MMM"), h("span", {}, "Invoice → XML Coretax")),
    h(
      "nav",
      {},
      state.view === "master"
        ? h("button", { class: "secondary", onclick: () => go("main") }, "← Invoice")
        : h("button", { class: "secondary", onclick: () => go("master") }, "Data master"),
      !DEMO && h("button", { class: "secondary", onclick: () => lock() }, "Kunci"),
    ),
    h("div", { id: "save-status", class: "save-status" }),
  );
}

function mainView() {
  return h(
    "main",
    {},
    h(
      "label",
      { class: "upload" },
      h("input", {
        type: "file",
        accept: "application/pdf,.pdf",
        multiple: true,
        onchange: (e) => {
          const files = [...e.target.files];
          e.target.value = "";
          addPdfs(files);
        },
      }),
      h("strong", {}, "Pilih PDF invoice"),
      h("span", {}, "Bisa beberapa file sekaligus. PDF dibaca di perangkat ini saja, tidak di-upload ke mana pun."),
    ),
    state.fakturs.length
      ? state.fakturs.map((f, i) => invoiceCard(state.invoices[i], f))
      : h("p", { class: "empty" }, "Belum ada invoice."),
    state.fakturs.length > 0 && exportPanel(),
    state.fakturs.length > 0 && exportBar(),
    codeDatalist(),
  );
}

async function addPdfs(files) {
  for (const file of files) {
    busy(`Membaca ${file.name}…`);
    try {
      const pages = await extractPages(pdfjs, new Uint8Array(await file.arrayBuffer()), { disableFontFace: true });
      const { invoices, warnings } = parseInvoices(pages);
      if (!invoices.length) toast(`${file.name}: tidak ada invoice yang terbaca`, "error");
      for (const invoice of invoices) {
        if (state.invoices.some((x) => x.number === invoice.number)) {
          toast(`${invoice.number} sudah ada di daftar`);
          continue;
        }
        invoice.warnings.push(...warnings);
        state.invoices.push(invoice);
      }
    } catch (err) {
      toast(`${file.name}: gagal dibaca (${err.message})`, "error");
    }
  }
  busy();
  state.invoices.sort((a, b) => a.number.localeCompare(b.number));
  render();
}

function invoiceCard(invoice, f) {
  const errors = f.checks.filter((c) => c.level === "error").length;
  const warnings = f.checks.filter((c) => c.level === "warn").length;
  const [level, label] = errors ? ["error", "Belum lengkap"] : warnings ? ["warn", "Perlu dicek"] : ["ok", "Siap"];
  const incomplete = f.lines.filter((l) => !isCode(l.code) || !isUnit(l.unit)).length;
  return h(
    "article",
    { class: `invoice ${level}` },
    h(
      "header",
      {},
      h("div", {}, h("strong", {}, f.number), h("small", {}, `${dateText(f.date)} · ${invoice.buyerName}`)),
      h("span", { class: `badge ${level}` }, label),
      h("button", { class: "icon", title: "Hapus dari daftar", "aria-label": `Hapus ${f.number} dari daftar`, onclick: () => removeInvoice(f.number) }, "✕"),
    ),
    buyerBlock(invoice, f),
    details(`checks:${f.number}`, errors + warnings > 0, `Pemeriksaan (${f.checks.length})`,
      h("ul", { class: "checks" }, f.checks.map((c) => h("li", { class: c.level }, c.message)))),
    details(`lines:${f.number}`, incomplete > 0, `${f.lines.length} baris barang${incomplete ? ` · ${incomplete} belum lengkap` : ""}`,
      f.lines.map((line, i) => lineRow(line, i))),
    h(
      "dl",
      { class: "totals" },
      h("dt", {}, "DPP"), h("dd", {}, num(f.totals.taxBaseSen)),
      h("dt", {}, "DPP Nilai Lain"), h("dd", {}, num(f.totals.otherTaxBaseSen)),
      h("dt", {}, "PPN"), h("dd", {}, num(f.totals.vatSen)),
    ),
  );
}

function removeInvoice(number) {
  state.invoices = state.invoices.filter((x) => x.number !== number);
  render();
}

function buyerBlock(invoice, f) {
  if (f.customer) {
    const trx = f.trxCode !== (state.master.settings.kodeTransaksi || "04") ? ` · kode transaksi ${f.trxCode}` : "";
    return h("p", { class: "buyer" }, "NPWP pembeli ", h("span", { class: "mono" }, mask(f.customer.npwp)), trx);
  }
  const form = h(
    "form",
    {
      class: "buyer-form",
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const npwp = M.normalizeNpwp(d.npwp);
        if (!npwp) return formError(form, "NPWP harus 16 digit angka.");
        const nitku = M.normalizeNitku(d.nitku, npwp);
        if (!nitku) return formError(form, "NITKU harus 22 digit angka, atau kosongkan untuk kantor pusat.");
        M.upsertCustomer(state.master, { name: invoice.buyerName, npwp, nitku });
        markDirty("customers");
        render();
      },
    },
    h("p", {}, "Pembeli ", h("strong", {}, invoice.buyerName), " belum ada di data master."),
    h(
      "div",
      { class: "row" },
      h("input", { name: "npwp", placeholder: "NPWP 16 digit", inputmode: "numeric", autocomplete: "off", required: true }),
      h("input", { name: "nitku", placeholder: "NITKU (kosong = pusat)", inputmode: "numeric", autocomplete: "off" }),
      h("button", { type: "submit" }, "Simpan"),
    ),
    state.master.customers.length > 0 &&
      h(
        "label",
        { class: "muted" },
        "Atau, kalau penulisan namanya beda dengan data master: ",
        h(
          "select",
          { onchange: (e) => useExistingCustomer(invoice.buyerName, e.target.value) },
          h("option", { value: "" }, "pilih pelanggan yang sama…"),
          [...state.master.customers].sort(byName).map((c) => h("option", { value: c.name }, c.name)),
        ),
      ),
    h("p", { class: "error", hidden: true }),
  );
  return form;
}

function useExistingCustomer(invoiceName, existingName) {
  const c = state.master.customers.find((x) => x.name === existingName);
  if (!c) return;
  M.upsertCustomer(state.master, { name: invoiceName, npwp: c.npwp, nitku: c.nitku, trxCode: c.trxCode });
  markDirty("customers");
  render();
}

function lineRow(line, i) {
  const complete = isCode(line.code) && isUnit(line.unit);
  return h(
    "div",
    { class: `line${complete ? "" : " missing"}` },
    h("div", { class: "line-name" }, h("span", { class: "no" }, i + 1), h("span", {}, line.name)),
    h(
      "div",
      { class: "line-calc" },
      `${qtyText(line.qty)} ${line.invoiceUnit} × ${num(line.priceSen)}`,
      line.discountSen ? ` − diskon ${num(line.discountSen)}` : "",
      ` = DPP ${num(line.taxBaseSen)} · PPN ${num(line.vatSen)}`,
    ),
    h(
      "div",
      { class: "line-inputs" },
      h("input", {
        class: isCode(line.code) ? "" : "invalid",
        value: line.code,
        placeholder: "Kode barang",
        inputmode: "numeric",
        maxlength: "6",
        list: "kode-barang",
        "aria-label": `Kode barang Coretax untuk ${line.name}`,
        onchange: (e) => setItemCode(line, e.target.value),
      }),
      h("button", {
        type: "button",
        class: "secondary",
        "aria-label": `Cari kode barang untuk ${line.name}`,
        onclick: () => openCodeSearch({ itemName: line.name, onPick: (code) => setItemCode(line, code) }),
      }, "Cari"),
      unitSelect({ value: line.unit, invalid: !isUnit(line.unit), onChange: (value) => setLineUnit(line, value) }),
    ),
  );
}

// ---------- pencarian kode barang ----------

let goodsCodes = null;

/** Kode yang pernah dipakai untuk barang yang namanya mengandung semua kata pencarian. */
function learnedCodes(query) {
  const terms = words(query);
  if (!terms.length) return [];
  const byCode = new Map();
  for (const it of Object.values(state.master.items)) {
    if (!isCode(it.coretaxCode) || !terms.every((t) => fold(it.name).includes(t))) continue;
    if (!byCode.has(it.coretaxCode)) byCode.set(it.coretaxCode, []);
    byCode.get(it.coretaxCode).push(it.name);
  }
  return [...byCode].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
}

async function openCodeSearch({ itemName, onPick }) {
  if (!goodsCodes) {
    busy("Memuat daftar kode barang…");
    try {
      goodsCodes = (await import("../src/kode-barang.js")).GOODS_CODES; // dimuat saat pertama kali dibutuhkan
    } catch (err) {
      return toast(`Daftar kode barang gagal dimuat: ${err.message}`, "error");
    } finally {
      busy();
    }
  }
  const names = new Map(goodsCodes.map(([code, indonesian]) => [code, indonesian]));
  const input = h("input", { type: "search", value: guessQuery(itemName), placeholder: "Nama barang atau angka kode, mis. baut", "aria-label": "Cari kode barang" });
  const results = h("div", { class: "results" });
  const onKey = (e) => e.key === "Escape" && close();
  const close = () => {
    dialog.remove();
    removeEventListener("keydown", onKey);
  };
  const option = (code, title, detail) =>
    h("button", { type: "button", class: "result", onclick: () => { close(); onPick(code); } },
      h("span", { class: "mono" }, code),
      h("span", {}, title, detail && h("small", {}, detail)));
  const update = () => {
    const used = learnedCodes(input.value);
    const found = searchCodes(goodsCodes, input.value);
    results.replaceChildren(
      ...(used.length
        ? [h("h4", {}, "Pernah kamu pakai"), ...used.map(([code, items]) =>
            option(code, names.get(code) ?? "", `untuk ${items.slice(0, 2).join(", ")}${items.length > 2 ? ` dan ${items.length - 2} barang lain` : ""}`))]
        : []),
      h("h4", {}, "Daftar kode barang Coretax"),
      ...(found.length
        ? found.map(([code, indonesian, english]) => option(code, indonesian, english))
        : [h("p", { class: "muted" }, input.value.trim() ? "Tidak ada yang cocok. Coba kata lain, atau kata dalam bahasa Inggris." : "Ketik nama barang atau angka kode.")]),
    );
  };
  input.addEventListener("input", update);
  const dialog = h(
    "div",
    { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "Cari kode barang", onclick: (e) => e.target === dialog && close() },
    h(
      "div",
      { class: "dialog-box" },
      h("header", {},
        h("div", {}, h("strong", {}, "Cari kode barang"), h("small", {}, itemName)),
        h("button", { type: "button", class: "icon", "aria-label": "Tutup", onclick: close }, "✕")),
      input,
      results,
    ),
  );
  addEventListener("keydown", onKey);
  document.body.append(dialog);
  update();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length); // kursor di akhir kata awal, siap ditambah
}

function setItemCode(line, value) {
  const code = value.replace(/\D/g, "");
  if (code && !isCode(code)) {
    toast("Kode barang Coretax harus 6 angka", "error");
    return render();
  }
  M.updateItem(state.master, line.itemCode, { coretaxCode: code }, line.name);
  markDirty("items");
  render();
}

function setLineUnit(line, unit) {
  const sat = normalizeUnit(line.invoiceUnit);
  const mapped = sat ? state.master.units[sat] : undefined;
  if (sat && !mapped && unit) {
    state.master.units[sat] = unit; // satuan baru: berlaku untuk semua barang dengan satuan ini
    markDirty("units");
    toast(`Satuan ${sat} sekarang otomatis ${UNIT_NAMES[unit]} untuk semua barang`);
  } else {
    M.updateItem(state.master, line.itemCode, { unit: unit === mapped ? "" : unit }, line.name);
    markDirty("items");
  }
  render();
}

function exportState() {
  const ready = state.fakturs.filter((f) => f.ready).length;
  const total = state.fakturs.length;
  const sellerOk = M.normalizeNpwp(state.master.settings.npwpPenjual) !== null;
  return { ready, total, sellerOk, canExport: ready === total && sellerOk };
}

/** Panel di bawah daftar: total, nama file, dan pilihan lain. */
function exportPanel() {
  const { ready, total, sellerOk, canExport } = exportState();
  const sum = (key) => state.fakturs.reduce((a, f) => a + f.totals[key], 0);
  if (!state.filename) state.filename = defaultFilename();
  return h(
    "section",
    { class: "export" },
    h("p", {}, h("strong", {}, `Total ${total} faktur`), ` · DPP ${num(sum("taxBaseSen"))} · PPN ${num(sum("vatSen"))}`),
    field("Nama file", h("input", { value: state.filename, oninput: (e) => (state.filename = e.target.value) })),
    h(
      "div",
      { class: "row" },
      typeof navigator.canShare === "function" && h("button", { class: "secondary", disabled: !canExport, onclick: () => exportXml(true) }, "Bagikan XML…"),
      h("button", { class: "link", onclick: () => { state.invoices = []; state.filename = ""; render(); } }, "Kosongkan daftar"),
    ),
    !sellerOk && h("p", { class: "error" }, "Isi dulu NPWP penjual di Data master → Pengaturan."),
    ready !== total && h("p", { class: "muted" }, "Lengkapi faktur yang belum siap, atau hapus dari daftar."),
  );
}

/** Baris ringkas yang selalu terlihat di bawah layar. */
function exportBar() {
  const { ready, total, canExport } = exportState();
  return h(
    "div",
    { class: "export-bar" },
    h("span", {}, h("strong", {}, `${ready} dari ${total}`), " faktur siap"),
    h("button", { disabled: !canExport, onclick: () => exportXml(false) }, "Download XML"),
  );
}

async function exportXml(share) {
  const s = state.master.settings;
  const npwp = M.normalizeNpwp(s.npwpPenjual);
  let xml;
  try {
    xml = buildXml({ tin: npwp, idtku: M.normalizeNitku(s.nitkuPenjual, npwp) }, state.fakturs, computeSettings());
  } catch (err) {
    return toast(err.message, "error");
  }
  const name = (state.filename.trim() || defaultFilename()).replace(/\.xml$/i, "") + ".xml";
  const file = new File([xml], name, { type: "application/xml" });
  if (share) {
    if (!navigator.canShare({ files: [file] })) return toast("Perangkat ini tidak bisa membagikan file, pakai Download.", "error");
    try {
      await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name !== "AbortError") toast(`Gagal membagikan: ${err.message}`, "error");
      return;
    }
  } else {
    const url = URL.createObjectURL(file);
    const link = h("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }
  const at = stamp();
  for (const f of state.fakturs) state.master.history.push({ number: f.number, invoiceDate: f.date, buyer: f.buyerName, exportedAt: at, file: name });
  markDirty("history");
  toast(`${name} dibuat (${state.fakturs.length} faktur)`, "ok");
  render();
}

function codeDatalist() {
  const codes = new Map();
  for (const it of Object.values(state.master.items)) if (isCode(it.coretaxCode) && !codes.has(it.coretaxCode)) codes.set(it.coretaxCode, it.name);
  return h("datalist", { id: "kode-barang" }, [...codes].sort().map(([code, name]) => h("option", { value: code }, `contoh: ${name}`)));
}

// ---------- data master ----------

let listBuilder = () => [];

function listSection(builder) {
  listBuilder = builder;
  return h("div", { id: "master-list" }, builder());
}

function searchBox(placeholder) {
  return h("input", {
    type: "search",
    class: "search",
    placeholder,
    value: state.query,
    oninput: (e) => {
      state.query = e.target.value;
      document.getElementById("master-list")?.replaceChildren(...listBuilder());
    },
  });
}

function masterView() {
  const m = state.master;
  const tabs = {
    customers: `Pelanggan (${m.customers.length})`,
    items: `Barang (${Object.keys(m.items).length})`,
    units: "Satuan",
    settings: "Pengaturan",
  };
  const body = { customers: customersTab, items: itemsTab, units: unitsTab, settings: settingsTab }[state.tab]();
  return h(
    "main",
    { class: "master" },
    h("nav", { class: "tabs" }, Object.entries(tabs).map(([key, label]) =>
      h("button", { class: state.tab === key ? "active" : "", onclick: () => { state.tab = key; state.query = ""; render(); } }, label))),
    body,
    codeDatalist(),
  );
}

function customersTab() {
  return [
    importCustomersBox(),
    searchBox("Cari nama, atau 4 angka terakhir NPWP"),
    listSection(() => {
      const q = state.query.trim().toUpperCase();
      const list = state.master.customers.filter((c) => !q || c.name.toUpperCase().includes(q) || String(c.npwp).endsWith(q)).sort(byName);
      if (!list.length) return [h("p", { class: "empty" }, q ? "Tidak ada yang cocok." : "Belum ada pelanggan.")];
      return [...list.slice(0, 200).map(customerRow), list.length > 200 && h("p", { class: "muted" }, "Ketik untuk mencari pelanggan lainnya.")];
    }),
  ];
}

function importCustomersBox() {
  const area = h("textarea", { rows: 4, placeholder: "NPWP [tab] Nama pelanggan, satu pelanggan per baris" });
  return details(
    "import-customers",
    state.master.customers.length === 0,
    "Tambah / impor pelanggan",
    h("p", { class: "muted" }, "Salin kolom NPWP dan Nama dari Excel, lalu tempel di sini. NITKU boleh ikut sebagai kolom ketiga. Di HP, pisahkan NPWP dan nama dengan titik koma (;). Pelanggan dengan nama yang sama akan diperbarui."),
    area,
    h(
      "button",
      {
        onclick: () => {
          const { customers, errors } = M.parsePastedCustomers(area.value);
          for (const c of customers) M.upsertCustomer(state.master, c);
          if (customers.length) markDirty("customers");
          state.importErrors = errors;
          toast(`${customers.length} pelanggan disimpan${errors.length ? `, ${errors.length} baris dilewati` : ""}`, errors.length ? "error" : "ok");
          render();
        },
      },
      "Simpan",
    ),
    state.importErrors.length > 0 && h("ul", { class: "checks" }, state.importErrors.map((e) => h("li", { class: "warn" }, e))),
  );
}

function customerRow(c) {
  const form = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const npwp = M.normalizeNpwp(d.npwp);
        if (!d.name.trim()) return formError(form, "Nama tidak boleh kosong.");
        if (!npwp) return formError(form, "NPWP harus 16 digit angka.");
        const nitku = M.normalizeNitku(d.nitku, npwp);
        if (!nitku) return formError(form, "NITKU harus 22 digit angka, atau kosongkan untuk kantor pusat.");
        M.removeCustomer(state.master, c.name);
        M.upsertCustomer(state.master, { name: d.name.trim(), npwp, nitku, trxCode: d.trxCode });
        markDirty("customers");
        render();
      },
    },
    field("Nama (sesuai tulisan di invoice)", h("input", { name: "name", value: c.name, required: true })),
    field("NPWP", h("input", { name: "npwp", value: c.npwp, inputmode: "numeric", autocomplete: "off", required: true })),
    field("NITKU", h("input", { name: "nitku", value: c.nitku, inputmode: "numeric", autocomplete: "off" })),
    field("Kode transaksi", trxSelect("trxCode", c.trxCode, "Ikut pengaturan")),
    h("p", { class: "error", hidden: true }),
    h(
      "div",
      { class: "row" },
      h("button", { type: "submit" }, "Simpan"),
      h("button", {
        type: "button",
        class: "danger",
        onclick: () => {
          if (!confirm(`Hapus ${c.name} dari data master?`)) return;
          M.removeCustomer(state.master, c.name);
          markDirty("customers");
          render();
        },
      }, "Hapus"),
    ),
  );
  return h("details", { class: "row-item" }, h("summary", {}, h("span", {}, c.name), h("span", { class: "mono muted" }, mask(c.npwp))), form);
}

function itemsTab() {
  return [
    h("p", { class: "muted" }, "Kode barang Coretax dan satuan yang pernah diisi diingat di sini, berdasarkan kode barang di invoice."),
    searchBox("Cari kode atau nama barang"),
    listSection(() => {
      const q = state.query.trim().toUpperCase();
      const list = Object.entries(state.master.items)
        .filter(([code, it]) => !q || code.toUpperCase().includes(q) || it.name.toUpperCase().includes(q) || it.coretaxCode.includes(q))
        .sort(([a], [b]) => a.localeCompare(b));
      if (!list.length) return [h("p", { class: "empty" }, q ? "Tidak ada yang cocok." : "Belum ada data barang.")];
      return [...list.slice(0, 200).map(([code, it]) => itemRow(code, it)), list.length > 200 && h("p", { class: "muted" }, "Ketik untuk mencari barang lainnya.")];
    }),
  ];
}

function itemRow(code, it) {
  const codeInput = h("input", { name: "coretaxCode", value: it.coretaxCode, inputmode: "numeric", maxlength: "6", list: "kode-barang" });
  const form = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const coretaxCode = d.coretaxCode.replace(/\D/g, "");
        if (coretaxCode && !isCode(coretaxCode)) return formError(form, "Kode barang Coretax harus 6 angka.");
        M.updateItem(state.master, code, { coretaxCode, unit: d.unit, opt: d.opt === "B" ? "B" : "" });
        markDirty("items");
        render();
      },
    },
    field(
      "Kode barang Coretax",
      h("div", { class: "code-field" },
        codeInput,
        h("button", {
          type: "button",
          class: "secondary",
          onclick: () => openCodeSearch({ itemName: it.name || code, onPick: (picked) => (codeInput.value = picked) }),
        }, "Cari")),
    ),
    field("Satuan Coretax", unitSelect({ name: "unit", value: it.unit, emptyLabel: "Ikut padanan satuan invoice" })),
    field("Jenis", h("select", { name: "opt" },
      h("option", { value: "A", selected: it.opt !== "B" }, "A - Barang"),
      h("option", { value: "B", selected: it.opt === "B" }, "B - Jasa"))),
    h("p", { class: "error", hidden: true }),
    h(
      "div",
      { class: "row" },
      h("button", { type: "submit" }, "Simpan"),
      h("button", {
        type: "button",
        class: "danger",
        onclick: () => {
          if (!confirm(`Hapus ${code} dari data master?`)) return;
          delete state.master.items[code];
          markDirty("items");
          render();
        },
      }, "Hapus"),
    ),
  );
  return h(
    "details",
    { class: "row-item" },
    h("summary", {}, h("span", {}, h("span", { class: "mono" }, code), " ", it.name), h("span", { class: "mono muted" }, it.coretaxCode || "—")),
    form,
  );
}

function unitsTab() {
  const units = state.master.units;
  const form = h(
    "form",
    {
      class: "row",
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const sat = normalizeUnit(d.sat);
        if (!sat || !d.unit) return;
        units[sat] = d.unit;
        markDirty("units");
        render();
      },
    },
    h("input", { name: "sat", placeholder: "Satuan di invoice, mis. PACK", required: true, autocapitalize: "characters" }),
    unitSelect({ name: "unit" }),
    h("button", { type: "submit" }, "Tambah"),
  );
  return [
    h("p", { class: "muted" }, "Satuan di invoice otomatis diubah menjadi satuan Coretax sesuai daftar ini."),
    Object.entries(units)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sat, unit]) => h("div", { class: "unit-row" }, h("span", { class: "mono" }, sat),
        unitSelect({ value: unit, onChange: (value) => { if (value) { units[sat] = value; markDirty("units"); render(); } } }))),
    h("h3", {}, "Tambah padanan satuan"),
    form,
  ];
}

function settingsTab() {
  const s = state.master.settings;
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const npwp = M.normalizeNpwp(d.npwpPenjual);
        if (!npwp) return formError(form, "NPWP penjual harus 16 digit angka.");
        const nitku = M.normalizeNitku(d.nitkuPenjual, npwp);
        if (!nitku) return formError(form, "NITKU penjual harus 22 digit angka, atau kosongkan.");
        Object.assign(s, {
          npwpPenjual: npwp,
          nitkuPenjual: nitku,
          kodeTransaksi: d.kodeTransaksi,
          pembulatanHargaInclude: d.pembulatanHargaInclude,
          namaFile: d.namaFile.trim() || M.DEFAULT_MASTER_SETTINGS.namaFile,
        });
        markDirty("settings");
        state.filename = "";
        toast("Pengaturan disimpan", "ok");
        render();
      },
    },
    h("h3", {}, "Penjual"),
    field("NPWP penjual (16 digit)", h("input", { name: "npwpPenjual", value: s.npwpPenjual, inputmode: "numeric", autocomplete: "off", required: true })),
    field("NITKU penjual", h("input", { name: "nitkuPenjual", value: s.nitkuPenjual, inputmode: "numeric", autocomplete: "off" }), "Kosongkan untuk kantor pusat (NPWP + 000000)."),
    h("h3", {}, "Faktur"),
    field("Kode transaksi default", trxSelect("kodeTransaksi", s.kodeTransaksi)),
    field(
      "Harga yang sudah termasuk PPN dibagi 1,11, lalu dibulatkan ke",
      h("select", { name: "pembulatanHargaInclude" },
        h("option", { value: "sen", selected: s.pembulatanHargaInclude !== "rupiah" }, "Sen (2 angka desimal)"),
        h("option", { value: "rupiah", selected: s.pembulatanHargaInclude === "rupiah" }, "Rupiah penuh")),
    ),
    field("Nama file XML", h("input", { name: "namaFile", value: s.namaFile }), "{DD} = tanggal, {MM} = bulan, {YYYY} = tahun saat file dibuat."),
    h("p", { class: "error", hidden: true }),
    h("button", { type: "submit" }, "Simpan pengaturan"),
  );
  return [form, securityBox()];
}

function securityBox() {
  if (DEMO) return h("section", { class: "card" }, h("p", {}, "Mode coba: data hanya ada di memori dan hilang saat halaman ditutup."));
  const pinForm = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const d = formData(pinForm);
        if (!/^\d{6,}$/.test(d.pin) || d.pin !== d.pin2) return formError(pinForm, "PIN minimal 6 angka dan kedua isian harus sama.");
        state.local.sealed = await seal(state.store.token, d.pin);
        state.local.failed = 0;
        writeLocal();
        pinForm.reset();
        formError(pinForm, "");
        toast("PIN diganti", "ok");
      },
    },
    field("PIN baru", pinInput("pin")),
    field("Ulangi PIN baru", pinInput("pin2")),
    h("p", { class: "error", hidden: true }),
    h("button", { type: "submit", class: "secondary" }, "Ganti PIN"),
  );
  return h(
    "section",
    { class: "card" },
    h("h3", {}, "Keamanan"),
    h("p", { class: "muted" }, `Data master ada di repo private ${state.store.label}. Token tersimpan terenkripsi di perangkat ini, dan aplikasi terkunci otomatis setelah 15 menit tidak dipakai.`),
    pinForm,
    h("h3", {}, "Perangkat ini"),
    h("button", {
      class: "danger",
      onclick: () => {
        if (!confirm("Hapus token dari perangkat ini? Untuk membuka data master lagi, token harus dimasukkan ulang.")) return;
        forgetDevice();
        location.reload();
      },
    }, "Putuskan perangkat ini"),
  );
}

start();
