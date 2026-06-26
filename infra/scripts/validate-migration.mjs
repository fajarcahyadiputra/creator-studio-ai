#!/usr/bin/env node
import fs from "node:fs";
import Module from "pg-query-emscripten";

const migrationPath =
  "apps/web-node/prisma/migrations/202606260001_init/migration.sql";
const sql = fs.readFileSync(migrationPath, "utf8");
const parser = await new Module();
const result = parser.parse(sql);
const statementCount = result.parse_tree?.stmts?.length ?? 0;
if (statementCount === 0) {
  throw new Error("The baseline migration contains no PostgreSQL statements.");
}
console.log(`Migration syntax is valid (${statementCount} statements).`);
