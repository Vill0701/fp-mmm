// Uji bagian aplikasi yang tidak butuh browser: kunci PIN dan penyimpanan GitHub (dengan fetch tiruan).
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubStore, StoreError } from "../app/storage.js";
import { seal, unseal, WrongPinError } from "../app/vault.js";

test("token terkunci PIN: PIN benar membuka, PIN salah ditolak", async () => {
  const token = "github_pat_uji_" + "x".repeat(40);
  const sealed = await seal(token, "123456");
  assert.ok(!JSON.stringify(sealed).includes(token), "token tidak boleh tersimpan apa adanya");
  assert.equal(await unseal(sealed, "123456"), token);
  await assert.rejects(unseal(sealed, "654321"), WrongPinError);
});

function fakeGitHub(repo) {
  const files = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
    const path = new URL(url).pathname;
    if (init.headers.Authorization !== "Bearer rahasia") return reply(401, {});
    if (path === "/repos/pemilik/data") return reply(200, repo);
    const name = decodeURIComponent(path.replace("/repos/pemilik/data/contents/", ""));
    const current = files.get(name);
    if (!init.method) {
      return current ? reply(200, { content: Buffer.from(current.text).toString("base64"), sha: current.sha }) : reply(404, {});
    }
    const body = JSON.parse(init.body);
    if ((current?.sha ?? undefined) !== body.sha) return reply(409, {});
    const sha = `sha${calls.length}`;
    files.set(name, { text: Buffer.from(body.content, "base64").toString("utf8"), sha });
    return reply(200, { content: { sha } });
  };
  return { files, calls, fetch };
}

test("repo data harus private dan bisa ditulis", async () => {
  const ok = fakeGitHub({ private: true, permissions: { push: true } });
  await new GitHubStore({ owner: "pemilik", repo: "data", token: "rahasia", fetch: ok.fetch }).check();

  const pub = fakeGitHub({ private: false, permissions: { push: true } });
  await assert.rejects(new GitHubStore({ owner: "pemilik", repo: "data", token: "rahasia", fetch: pub.fetch }).check(), /PUBLIC/);

  const readOnly = fakeGitHub({ private: true, permissions: { push: false } });
  await assert.rejects(new GitHubStore({ owner: "pemilik", repo: "data", token: "rahasia", fetch: readOnly.fetch }).check(), /Read and write/);

  await assert.rejects(new GitHubStore({ owner: "pemilik", repo: "data", token: "salah", fetch: ok.fetch }).check(), /ditolak/);
});

test("baca dan simpan file, termasuk huruf non-ASCII; konflik dilaporkan", async () => {
  const gh = fakeGitHub({ private: true, permissions: { push: true } });
  const store = new GitHubStore({ owner: "pemilik", repo: "data", token: "rahasia", fetch: gh.fetch });
  assert.equal(await store.read("pelanggan.csv"), null);

  const sha = await store.write("pelanggan.csv", "nama\nPT ÉLAN – JAYA\n", undefined, "Perbarui pelanggan.csv");
  assert.deepEqual(await store.read("pelanggan.csv"), { text: "nama\nPT ÉLAN – JAYA\n", sha });
  assert.ok(gh.calls.every((c) => c.init.cache === "no-store"));

  await assert.rejects(store.write("pelanggan.csv", "nama\n", "sha-lama", "x"), (err) => err instanceof StoreError && err.status === 409);
});
