import { chmod, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { resolveDataRoot } from "./data-root.mjs";

const target = resolveDataRoot();
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
