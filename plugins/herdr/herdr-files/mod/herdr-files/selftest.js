// `herdr-files.selftest`: drives a separate DocController with the real readTextFile,
// writeTextFile and EditorState against fixtures in a fresh `mktemp -d` folder.
// It writes only inside that folder, never anywhere a caller names.
// Result: /tmp/herdr-files-selftest.XXXXXX/result.json, and a toast.
import { exec, readTextFile, writeTextFile, notify } from "herdr";
import { DocController } from "./core.js";

export async function selftest(_cx, makeState) {
  const mk = await exec("mktemp", ["-d", "/tmp/herdr-files-selftest.XXXXXX"]);
  const dir = mk.stdout.trim();
  if (mk.code !== 0 || !dir.startsWith("/tmp/herdr-files-selftest.")) throw new Error("mktemp failed: " + mk.stderr);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const states = [];
  const docs = new DocController({
    read: (path, on) => readTextFile(path, { on }),
    write: (path, text, expected) => writeTextFile(path, text, expected),
    makeState: (o) => { const s = makeState(o); states.push(s); return s; },
  });
  const type = (text) => { docs.doc.state.set_value(text); docs.changed(docs.doc, null); };
  const f = (name) => `${dir}/${name}`;
  try {
    await writeTextFile(f("note one.md"), "# one\n", null);
    await writeTextFile(f("b.md"), "b\n", null);
    await writeTextFile(f("big.md"), "x".repeat(400001), null);
    await writeTextFile(f("code.js"), "let a = 1;\n", null);
    await exec("sh", ["-c", 'printf "a\\000b" > "$1"', "sh", f("bin.md")]);

    check("open editable (path with space)", await docs.open(f("note one.md"), null) && docs.editable && !docs.dirty);
    type("# one\nedited\n");
    check("edit marks dirty", docs.dirty);
    check("close is held while dirty", !docs.request({ kind: "close" }) && docs.pendingNav?.kind === "close");
    check("cancel keeps document", (await docs.resolve("cancel")) === null && docs.dirty);
    let r = await docs.save();
    check("save writes", r === "saved" && !docs.dirty && (await readTextFile(f("note one.md"))) === "# one\nedited\n", r);

    await writeTextFile(f("note one.md"), "external\n", "# one\nedited\n");
    type("mine\n");
    r = await docs.save();
    check("external change -> conflict, disk kept", r === "conflict" && docs.doc.conflict?.disk === "external\n" && (await readTextFile(f("note one.md"))) === "external\n", r);
    r = await docs.save("overwrite");
    check("explicit overwrite", r === "saved" && (await readTextFile(f("note one.md"))) === "mine\n", r);

    await exec("rm", ["-f", f("note one.md")]);
    type("again\n");
    r = await docs.save();
    check("deleted -> deleted, not recreated", r === "deleted" && (await readTextFile(f("note one.md"))) === null, r);
    r = await docs.save("recreate");
    check("explicit recreate", r === "saved" && (await readTextFile(f("note one.md"))) === "again\n", r);

    const first = docs.open(f("note one.md"), null), second = docs.open(f("b.md"), null);
    const [a, b] = await Promise.all([first, second]);
    check("stale load discarded", a === false && b === true && docs.doc.path === f("b.md"));

    await docs.open(f("big.md"), null);
    check("truncated is read-only", docs.doc.readonly === "truncated" && (await docs.save()) === "failed");
    await docs.open(f("bin.md"), null);
    check("binary has no editor", !docs.doc.state && /Binary/.test(docs.doc.message ?? ""));
    await docs.open(f("code.js"), null);
    check("non-text preview read-only", docs.doc.readonly === "preview");
    check("files untouched", (await readTextFile(f("big.md")))?.length === 400001 && (await readTextFile(f("code.js"))) === "let a = 1;\n");
  } catch (e) {
    check("no exception", false, String(e?.stack ?? e));
  } finally {
    docs.close();
    for (const s of states) try { s.release(); } catch {}
  }
  const passed = results.filter(x => x.ok).length;
  const summary = { ok: passed === results.length, passed, total: results.length, dir, results };
  await writeTextFile(`${dir}/result.json`, JSON.stringify(summary, null, 2), null).catch(() => {});
  notify({ title: "herdr-files selftest", body: `${passed}/${results.length} passed · ${dir}/result.json`, level: summary.ok ? "info" : "error" });
  return summary;
}
