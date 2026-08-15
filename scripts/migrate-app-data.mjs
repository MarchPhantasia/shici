import { chmod, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const roots = {
  darwin: join(homedir(), "Library", "Application Support", "com.pha.shici"),
  win32: join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "com.pha.shici"),
  linux: join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "com.pha.shici"),
};
const target = roots[process.platform];
if (!target) process.exit(0);

await mkdir(target, { recursive: true, mode: 0o700 });
for (const name of ["settings.json", "library.json"]) {
  try {
    await copyFile(new URL(`../.local/${name}`, import.meta.url), join(target, name), constants.COPYFILE_EXCL);
    await chmod(join(target, name), 0o600).catch(() => {});
    console.log(`已迁移 ${name} 到应用数据目录`);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  }
}
