import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDataRoot({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "com.pha.shici");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "com.pha.shici");
  if (platform === "linux") return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "com.pha.shici");
  return "";
}
