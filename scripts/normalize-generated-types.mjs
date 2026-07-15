import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/app-server/generated/", import.meta.url));

async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalize(path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = await readFile(path, "utf8");
    const updated = source.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+?)(["'];)/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${/\.[a-z]+$/i.test(specifier) ? specifier : `${specifier}.js`}${suffix}`,
    ).replace('from "./v2.js"', 'from "./v2/index.js"');
    if (updated !== source) await writeFile(path, updated, "utf8");
  }
}

await normalize(root);
