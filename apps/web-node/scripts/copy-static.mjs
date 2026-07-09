import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");

function copyDirectory(sourceRelativePath, destinationRelativePath) {
  const sourcePath = resolve(appDir, sourceRelativePath);
  const destinationPath = resolve(appDir, destinationRelativePath);

  mkdirSync(destinationPath, { recursive: true });
  cpSync(sourcePath, destinationPath, { recursive: true });
}

copyDirectory("src/views", "dist/views");
copyDirectory("src/public", "dist/public");
