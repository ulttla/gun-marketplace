// Ollama device-key signer, copied from the verified reference (internal function only).
// The header it returns must never be logged, written, returned to a UI or put in argv.
// Scheme: Authorization: <base64 SSH-wire ed25519 pubkey>:<base64 sig of "METHOD,PATH?ts=TS">.
// Undocumented for /api/balance (docs list Bearer API keys); it may change.
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { homedir } from "node:os";

export function ollamaAuthHeader(method, path, ts, keyPath = `${homedir()}/.ollama/id_ed25519`) {
  const pem = readFileSync(keyPath, "utf8");
  const b = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  if (b.subarray(0, magic.length).toString() !== magic) throw new Error("unexpected key format");
  let o = magic.length;
  const rd = () => { const n = b.readUInt32BE(o); o += 4; const v = b.subarray(o, o + n); o += n; return v; };
  const cipher = rd().toString(); rd(); rd(); // ciphername, kdfname, kdfoptions
  if (cipher !== "none") throw new Error("key is passphrase-protected");
  o += 4; // number of keys
  const pub = rd();  // public key blob (SSH wire format)
  const priv = rd(); // private section
  let p = 8;         // skip checkint pair
  const rd2 = () => { const n = priv.readUInt32BE(p); p += 4; const v = priv.subarray(p, p + n); p += n; return v; };
  if (rd2().toString() !== "ssh-ed25519") throw new Error("not ed25519");
  rd2();             // public key bytes
  const sk = rd2();  // 64 bytes: seed(32) + public(32)
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sk.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  const sig = sign(null, Buffer.from(`${method},${path}?ts=${ts}`), key).toString("base64");
  return `${pub.toString("base64")}:${sig}`;
}
