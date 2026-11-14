// CI check: both marketplace catalogs list herdr-files at this folder, and its
// versions agree across the manifests, package.json and lib/setup.mjs.
//   node plugins/herdr/herdr-files/test/catalog-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(plugin, "../../..");
const rel = "./" + path.relative(root, plugin).split(path.sep).join("/");
const errors = [];
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { errors.push(`${path.relative(root, f)}: ${e.message}`); return null; } };

const claude = json(path.join(root, ".claude-plugin/marketplace.json"))?.plugins?.find((p) => p.name === "herdr-files");
if (!claude) errors.push(".claude-plugin/marketplace.json: herdr-files missing");
else if (claude.source !== rel || claude.category !== "herdr") errors.push(`.claude-plugin/marketplace.json: herdr-files should have source ${rel} and category herdr`);
const codex = json(path.join(root, ".agents/plugins/marketplace.json"))?.plugins?.find((p) => p.name === "herdr-files");
if (!codex) errors.push(".agents/plugins/marketplace.json: herdr-files missing");
else if (codex.source?.path !== rel) errors.push(`.agents/plugins/marketplace.json: herdr-files should have source.path ${rel}`);

const versions = {
  ".claude-plugin/plugin.json": json(path.join(plugin, ".claude-plugin/plugin.json"))?.version,
  ".codex-plugin/plugin.json": json(path.join(plugin, ".codex-plugin/plugin.json"))?.version,
  "package.json": json(path.join(plugin, "package.json"))?.version,
  "lib/setup.mjs": fs.readFileSync(path.join(plugin, "lib/setup.mjs"), "utf8").match(/VERSION = "([^"]+)"/)?.[1],
};
if (new Set(Object.values(versions)).size !== 1) errors.push(`herdr-files versions differ: ${JSON.stringify(versions)}`);
for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) if (json(path.join(plugin, f))?.name !== "herdr-files") errors.push(`${f}: name should be herdr-files`);

const skill = fs.readFileSync(path.join(plugin, "skills/herdr-files/SKILL.md"), "utf8").replaceAll("\r\n", "\n");
const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm || !/^name: herdr-files$/m.test(fm[1]) || !/^description: \S/m.test(fm[1])) errors.push("skills/herdr-files/SKILL.md: frontmatter needs name: herdr-files and a description");
for (const f of ["LICENSE", "THIRD-PARTY-NOTICES.md", "LICENSES/Apache-2.0.txt"]) if (!fs.existsSync(path.join(plugin, f))) errors.push(`${f} missing`);

if (errors.length) { for (const e of errors) console.error(`error: ${e}`); process.exit(1); }
console.log(`catalogs ok; herdr-files ${versions["package.json"]}`);
