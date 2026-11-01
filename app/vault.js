// Token GitHub disimpan di perangkat dalam keadaan terenkripsi (AES-GCM) dengan kunci dari PIN (PBKDF2).
// Tanpa PIN yang benar, token tidak bisa dibuka.

const ITERATIONS = 310000;
const encoder = new TextEncoder();

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(secret, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(secret)));
  return { v: 1, iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
}

export class WrongPinError extends Error {
  constructor() {
    super("PIN salah");
  }
}

export async function unseal(sealed, pin) {
  const key = await deriveKey(pin, fromBase64(sealed.salt), sealed.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new WrongPinError();
  }
}
