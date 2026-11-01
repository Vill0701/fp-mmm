// Membaca dan menyimpan file data master di repo GitHub private lewat GitHub API.
// Respons API tidak disimpan di cache browser (cache: "no-store").

const API = "https://api.github.com";
// Info izin di respons repo menggambarkan akun, bukan token, jadi izin token baru ketahuan saat membaca/menulis isi file.
const MISSING_PERMISSION = "Token belum diberi izin Contents: Read and write untuk repo data. Buat token baru dengan izin itu.";

export class StoreError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export class GitHubStore {
  constructor({ owner, repo, token, fetch = globalThis.fetch.bind(globalThis) }) {
    Object.assign(this, { owner, repo, token, fetch });
  }

  get label() {
    return `${this.owner}/${this.repo}`;
  }

  async #request(path, init = {}) {
    let res;
    try {
      res = await this.fetch(`${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new StoreError("Tidak bisa terhubung ke GitHub. Periksa koneksi internet.", 0);
    }
    if (res.status === 401) throw new StoreError("Token GitHub ditolak (salah, dicabut, atau kedaluwarsa).", 401);
    return res;
  }

  /** Pastikan repo bisa diakses, bersifat private, dan token boleh menulis. */
  async check() {
    const res = await this.#request("");
    if (res.status === 404) {
      throw new StoreError(`Repo ${this.label} tidak ditemukan, atau token tidak diberi akses ke repo ini.`, 404);
    }
    if (!res.ok) throw new StoreError(`GitHub menolak permintaan (${res.status}).`, res.status);
    const info = await res.json();
    if (!info.private) {
      throw new StoreError(`Repo ${this.label} bersifat PUBLIC. Data NPWP hanya boleh disimpan di repo PRIVATE.`, 403);
    }
    if (info.permissions && !info.permissions.push) {
      throw new StoreError("Token hanya bisa membaca. Beri izin Contents: Read and write.", 403);
    }
    return info;
  }

  /** Isi file beserta sha-nya, atau null kalau file belum ada. */
  async read(path) {
    const res = await this.#request(`/contents/${encodeURIComponent(path)}`);
    if (res.status === 404) return null;
    if (res.status === 403) throw new StoreError(MISSING_PERMISSION, 403);
    if (!res.ok) throw new StoreError(`Gagal membaca ${path} (${res.status}).`, res.status);
    const file = await res.json();
    return { text: fromBase64(file.content), sha: file.sha };
  }

  /** Simpan file; `sha` wajib untuk file yang sudah ada. Mengembalikan sha baru. */
  async write(path, text, sha, message) {
    const res = await this.#request(`/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: toBase64(text), ...(sha ? { sha } : {}) }),
    });
    if (res.status === 409 || res.status === 422) {
      throw new StoreError(`${path} sudah diubah dari perangkat lain.`, 409);
    }
    if (res.status === 403) throw new StoreError(MISSING_PERMISSION, 403);
    if (!res.ok) throw new StoreError(`Gagal menyimpan ${path} (${res.status}).`, res.status);
    return (await res.json()).content.sha;
  }
}

/** Penyimpanan sementara di memori untuk mode coba: tidak ada yang disimpan. */
export class MemoryStore {
  label = "mode coba (tidak disimpan)";
  #files = new Map();

  async check() {
    return { private: true };
  }

  async read(path) {
    return this.#files.get(path) ?? null;
  }

  async write(path, text) {
    const sha = String(Date.now());
    this.#files.set(path, { text, sha });
    return sha;
  }
}
