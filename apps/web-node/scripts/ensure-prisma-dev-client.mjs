import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const generatedDir = resolve(process.cwd(), "src/generated/prisma");
const clientTs = resolve(generatedDir, "client.ts");
const clientJs = resolve(generatedDir, "client.js");

if (!existsSync(clientTs)) {
  throw new Error(
    `Prisma generated client was not found at ${clientTs}. Run prisma generate first.`
  );
}

writeFileSync(
  clientJs,
  [
    "// Dev-runtime shim for Prisma 7's TypeScript client output.",
    "// Production builds compile client.ts to dist/generated/prisma/client.js.",
    'export * from "./client.ts";',
    ""
  ].join("\n"),
  "utf8"
);
