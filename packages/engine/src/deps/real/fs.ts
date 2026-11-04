// Real file access, async, with atomic writes (temp file, then rename).
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Fs, Random } from "../types.js";

export function realFs(random: Random): Fs {
  return {
    read: (file) => fsp.readFile(file, "utf8"),
    readBytes: async (file) => new Uint8Array(await fsp.readFile(file)),
    async writeAtomic(file, data) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${random.id()}.tmp`);
      await fsp.writeFile(temp, data);
      await fsp.rename(temp, file);
    },
    append: (file, data) => fsp.appendFile(file, data),
    rename: (from, to) => fsp.rename(from, to),
    remove: (file, o) => fsp.rm(file, { force: true, recursive: Boolean(o?.recursive) }),
    mkdir: async (dir) => {
      await fsp.mkdir(dir, { recursive: true });
    },
    async stat(file) {
      try {
        const info = await fsp.stat(file);
        const kind = info.isFile() ? "file" : info.isDirectory() ? "dir" : "other";
        return { kind, size: info.size, mtimeMs: info.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async realpath(file) {
      try {
        return await fsp.realpath(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    list: (dir) => fsp.readdir(dir),
  };
}
