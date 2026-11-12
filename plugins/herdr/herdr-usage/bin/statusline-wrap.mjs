// Windows statusline: preserve the input bytes, output and original exit status.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
process.env.HERDR_USAGE_HOME ||= path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [src, encoded] = process.argv.slice(2);
const input = fs.readFileSync(0);
let code = 0;
if (encoded) {
  const command = Buffer.from(encoded, "base64").toString("utf8");
  const env = { ...process.env };
  // Claude's Windows installer can provide Git Bash outside the inherited PATH.
  if (process.platform === "win32" && /^bash\s/.test(command)) {
    const gitBin = path.join(process.env.ProgramFiles || "C:/Program Files", "Git", "bin");
    if (fs.existsSync(path.join(gitBin, "bash.exe"))) env.PATH = `${gitBin};${env.PATH || ""}`;
  }
  const result = spawnSync(command, { shell: true, env, input, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  code = result.status ?? 1;
}
// Capture is bounded local file I/O; no network or child process is needed.
try {
  const { capturePayload } = await import("../lib/capture.mjs");
  capturePayload(src, input.toString("utf8"));
} catch {}
process.exitCode = code;
