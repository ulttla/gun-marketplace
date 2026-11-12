// Key-only, atomic edits of a CLI's statusLine. Only `statusLine` changes; the
// rest of the file is re-read just before rename, and a concurrent change
// restarts the edit. The original value is kept in a 0600 state file, never a
// copy of the whole settings file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeAtomic, readJson } from "./util.mjs";

// Any usage home (HERDR_USAGE_HOME may move it): the wrapper is "<home>/bin/statusline-wrap".
export const WRAP_RE = /[\\/]bin[\\/]statusline-wrap(?:\.mjs)?['"]? (claude|agy)( [A-Za-z0-9+\/=]+)?(?:; exit \$LASTEXITCODE)?$/;

// agy runs cmd.exe through Go's Windows argument quoting. Literal quotes in
// the command become escaped quotes, so keep its outer command quote-free.
const PS_RE = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/;
function wrapperText(sl) {
  if (typeof sl?.command !== "string") return "";
  const m = sl.command.match(PS_RE);
  return m ? Buffer.from(m[1], "base64").toString("utf16le") : sl.command;
}
export const isWrapper = (sl) => WRAP_RE.test(wrapperText(sl));

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? (m[1].includes("\t") ? "\t" : m[1].length) : 2;
}

/** Apply fn(obj) -> {changed, ...} to a JSON file atomically, retrying on concurrent edits. */
export function editJson(file, fn, { create = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let text = null, mode = 0o600;
    try { text = fs.readFileSync(file, "utf8"); mode = fs.statSync(file).mode & 0o777; }
    catch (e) { if (e.code !== "ENOENT" || !create) throw e; }
    const obj = text ? JSON.parse(text) : {};
    const indent = text ? detectIndent(text) : 2;
    const nl = text ? (text.endsWith("\n") ? "\n" : "") : "\n";
    if (text && JSON.stringify(JSON.parse(text), null, indent) + nl !== text) {
      throw new Error(`${path.basename(file)}: formatting would change on rewrite; edit statusLine by hand`);
    }
    const res = fn(obj);
    if (!res.changed) return res;
    const out = JSON.stringify(obj, null, indent) + nl;
    const tmp = `${file}.herdr-usage-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, out, { mode });
    fs.chmodSync(tmp, mode);
    let again = null;
    try { again = fs.readFileSync(file, "utf8"); } catch {}
    if (again !== text) { fs.unlinkSync(tmp); continue; }
    fs.renameSync(tmp, file);
    return res;
  }
  throw new Error(`${path.basename(file)} kept changing; try again`);
}

export function wrapperCommand(wrapPath, src, origCommand) {
  const enc = origCommand ? Buffer.from(origCommand, "utf8").toString("base64") : "";
  if (process.platform === "win32") {
    const node = (process.env.HERDR_USAGE_NODE || process.execPath).replaceAll("\\", "/");
    if (src === "agy") {
      const quote = (s) => `'${s.replaceAll("'", "''")}'`;
      const script = `& ${quote(node)} ${quote(wrapPath.replaceAll("\\", "/"))} ${src}${enc ? ` ${enc}` : ""}; exit $LASTEXITCODE`;
      return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    }
    return `"${node}" "${wrapPath.replaceAll("\\", "/")}" ${src}${enc ? ` ${enc}` : ""}`;
  }
  return `/bin/sh '${wrapPath.replace(/'/g, "'\\''")}' ${src}${enc ? ` ${enc}` : ""}`;
}

/** Throws (with a reason to show) when editJson could not edit this file. A missing file is fine. */
export function checkEditable(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; fix it or skip this CLI`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${file} is not a JSON object`);
  const nl = text.endsWith("\n") ? "\n" : "";
  if (JSON.stringify(obj, null, detectIndent(text)) + nl !== text) throw new Error(`${file}: formatting would change on rewrite; reformat it as 2-space JSON or skip this CLI`);
}

/** Wrap the current statusLine. Idempotent: an existing wrapper is never wrapped again.
 *  `create`: the file may be missing (its folder exists); then it is created and uninstall removes it again if left empty. */
export function installStatusLine({ file, src, wrapPath, origFile, create = false }) {
  const created = create && !fs.existsSync(file);
  return editJson(file, (obj) => {
    const cur = obj.statusLine;
    if (isWrapper(cur)) {
      // Repair older Windows agy commands on update without replacing the
      // saved original with our own wrapper (including the short-path fix).
      if (process.platform === "win32" && src === "agy") {
        const command = wrapperCommand(wrapPath, src, originalFromWrapper(cur));
        if (cur.command !== command) {
          obj.statusLine = { ...cur, command };
          return { changed: true, note: "updated Windows agy launcher" };
        }
      }
      return { changed: false, note: "already wrapped" };
    }
    writeAtomic(origFile, JSON.stringify({ present: Object.prototype.hasOwnProperty.call(obj, "statusLine"), value: cur ?? null, ...(created ? { created: true } : {}) }) + "\n");
    const runnable = cur && cur.type === "command" && typeof cur.command === "string" && cur.command.trim() && cur.enabled !== false;
    const next = { ...(cur && typeof cur === "object" ? cur : {}), type: "command", command: wrapperCommand(wrapPath, src, runnable ? cur.command : "") };
    if (src === "agy") { next.enabled = true; next.stack_with_default = true; }
    obj.statusLine = next;
    return { changed: true, note: runnable ? "wrapped existing command" : "added capture-only statusline" };
  }, { create });
}

/** The original command carried in the wrapper's argv (base64), or null. */
export function originalFromWrapper(sl) {
  const m = isWrapper(sl) && wrapperText(sl).match(/statusline-wrap(?:\.mjs)?['"]? [a-z]+ ([A-Za-z0-9+/=]+)(?:; exit \$LASTEXITCODE)?$/);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : null;
}

/** Restore the original only if the current value is still our wrapper. */
export function uninstallStatusLine({ file, origFile }) {
  const orig = readJson(origFile);
  const valid = orig && typeof orig === "object" && typeof orig.present === "boolean";
  if (!valid) {
    // State lost: recover from the wrapper's argv, else leave it and warn (never strand the wrapper).
    let cur = null;
    try { cur = readJson(file)?.statusLine; } catch {}
    if (!isWrapper(cur)) return { changed: false, note: "no saved original" };
    const cmd = originalFromWrapper(cur);
    if (cmd == null) return { changed: false, unsafe: true, note: "wrapper still set but original unknown; left as is" };
    return editJson(file, (obj) => {
      if (!isWrapper(obj.statusLine)) return { changed: false, note: "statusLine changed since install; left as is" };
      obj.statusLine = { ...obj.statusLine, command: originalFromWrapper(obj.statusLine) };
      return { changed: true, note: "restored command from wrapper argv (saved original missing)" };
    });
  }
  let res;
  try {
    res = editJson(file, (obj) => {
      if (!isWrapper(obj.statusLine)) return { changed: false, note: "statusLine changed since install; left as is" };
      if (orig.present) obj.statusLine = orig.value;
      else delete obj.statusLine;
      return { changed: true, note: "restored" };
    });
  } catch (e) {
    if (e.code === "ENOENT") return { changed: false, note: "settings file missing" };
    throw e;
  }
  if (res.changed) {
    fs.unlinkSync(origFile);
    // The installer created this file: remove it again if nothing else was added.
    if (orig.created) { try { if (fs.readFileSync(file, "utf8").trim() === "{}") fs.unlinkSync(file); } catch {} }
  }
  return res;
}
