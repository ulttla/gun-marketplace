// CI check: both marketplace catalogs list herdr-usage, every catalog source
// exists with a manifest of the same name, and herdr-usage's versions agree.
//   node plugins/herdr/herdr-usage/test/catalog-check.mjs   (from the repository root or anywhere)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(plugin, "../../..");
const errors = [];
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { errors.push(`${path.relative(root, f)}: ${e.message}`); return null; } };

const catalogs = [
  { file: ".claude-plugin/marketplace.json", src: (p) => p.source, manifest: ".claude-plugin/plugin.json" },
  { file: ".agents/plugins/marketplace.json", src: (p) => p.source?.path, manifest: ".codex-plugin/plugin.json" },
];
for (const c of catalogs) {
  const cat = json(path.join(root, c.file));
  if (!cat) continue;
  const names = new Set();
  for (const p of cat.plugins ?? []) {
    if (names.has(p.name)) errors.push(`${c.file}: duplicate ${p.name}`);
    names.add(p.name);
    const dir = path.join(root, c.src(p) ?? "");
    const man = fs.existsSync(path.join(dir, c.manifest)) ? json(path.join(dir, c.manifest)) : null;
    if (!man) errors.push(`${c.file}: ${p.name} has no ${c.manifest} at ${c.src(p)}`);
    else if (man.name !== p.name) errors.push(`${c.file}: ${p.name} manifest is named ${man.name}`);
  }
  if (!names.has("herdr-usage")) errors.push(`${c.file}: herdr-usage missing`);
}

const versions = {
  ".claude-plugin/plugin.json": json(path.join(plugin, ".claude-plugin/plugin.json"))?.version,
  ".codex-plugin/plugin.json": json(path.join(plugin, ".codex-plugin/plugin.json"))?.version,
  "package.json": json(path.join(plugin, "package.json"))?.version,
  "lib/setup.mjs": fs.readFileSync(path.join(plugin, "lib/setup.mjs"), "utf8").match(/VERSION = "([^"]+)"/)?.[1],
};
if (new Set(Object.values(versions)).size !== 1) errors.push(`herdr-usage versions differ: ${JSON.stringify(versions)}`);

const skill = fs.readFileSync(path.join(plugin, "skills/herdr-usage/SKILL.md"), "utf8").replaceAll("\r\n", "\n");
const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm || !/^name: herdr-usage$/m.test(fm[1]) || !/^description: \S/m.test(fm[1])) errors.push("skills/herdr-usage/SKILL.md: frontmatter needs name: herdr-usage and a description");

if (errors.length) { for (const e of errors) console.error(`error: ${e}`); process.exit(1); }
console.log(`catalogs ok; herdr-usage ${versions["package.json"]}`);
