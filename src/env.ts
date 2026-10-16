// Loads secrets from a dotenv-style file into process.env without overriding existing values.
// Never logs values. Default path can be changed with SECRETS_FILE.
import fs from "node:fs";

export const DEFAULT_SECRETS_FILE = "/workspace/secrets/secretary-bot.env";

export function loadSecrets(path = process.env.SECRETS_FILE || DEFAULT_SECRETS_FILE): string[] {
  let raw: string;
  try { raw = fs.readFileSync(path, "utf8"); } catch { return []; }
  const loaded: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]] && val) { process.env[m[1]] = val; loaded.push(m[1]); }
  }
  return loaded; // names only
}
