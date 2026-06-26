#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getSchema } from "@mrleebo/prisma-ast";

const root = process.cwd();
const schemaPath = path.join(root, "apps/web-node/prisma/schema.prisma");
const outputPath = path.join(root, "apps/web-node/prisma/migrations/202606260001_init/migration.sql");
const ast = getSchema(fs.readFileSync(schemaPath, "utf8"));
const enumEntries = ast.list.filter((item) => item.type === "enum");
const modelEntries = ast.list.filter((item) => item.type === "model");
const enums = new Map(enumEntries.map((item) => [item.name, item.enumerators.map((entry) => entry.name)]));
const models = new Set(modelEntries.map((item) => item.name));

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const attr = (field, name, group) =>
  (field.attributes ?? []).find(
    (item) => item.name === name && (group === undefined || item.group === group),
  );
const valueOf = (arg) => arg?.value;
const firstValue = (attribute) => valueOf(attribute?.args?.[0]);
const arrayValue = (attribute) => {
  const value = firstValue(attribute);
  return value?.type === "array" ? value.args : [];
};
const keyValues = (attribute) => {
  const result = {};
  for (const arg of attribute?.args ?? []) {
    const value = valueOf(arg);
    if (value?.type === "keyValue") result[value.key] = value.value;
  }
  return result;
};
const arrayFromKey = (value) => (value?.type === "array" ? value.args : []);

function sqlType(field) {
  const native = (field.attributes ?? []).find((item) => item.group === "db");
  if (native?.name === "Uuid") return "UUID";
  if (native?.name === "VarChar") return `VARCHAR(${firstValue(native)})`;
  if (native?.name === "Char") return `CHAR(${firstValue(native)})`;
  if (native?.name === "Decimal") {
    const args = (native.args ?? []).map((item) => valueOf(item));
    return `DECIMAL(${args.join(",")})`;
  }
  if (enums.has(field.fieldType)) return quote(field.fieldType);
  const mapped = {
    String: "TEXT",
    DateTime: "TIMESTAMP(3)",
    Int: "INTEGER",
    BigInt: "BIGINT",
    Boolean: "BOOLEAN",
    Json: "JSONB",
    Decimal: "DECIMAL(65,30)",
  }[field.fieldType];
  if (!mapped) throw new Error(`Unsupported scalar type ${field.fieldType}`);
  return mapped;
}

function defaultSql(field) {
  const defaultAttribute = attr(field, "default");
  if (!defaultAttribute) return "";
  const value = firstValue(defaultAttribute);
  if (value?.type === "function") {
    if (value.name === "uuid") return "DEFAULT gen_random_uuid()";
    if (value.name === "now") return "DEFAULT CURRENT_TIMESTAMP";
    throw new Error(`Unsupported default function ${value.name}`);
  }
  if (typeof value === "boolean" || /^-?\d+(\.\d+)?$/.test(String(value))) return `DEFAULT ${value}`;
  if (typeof value === "string" && value.startsWith('"')) {
    const parsed = JSON.parse(value);
    if (field.fieldType === "Json") return `DEFAULT '${String(parsed).replaceAll("'", "''")}'::JSONB`;
    return `DEFAULT '${String(parsed).replaceAll("'", "''")}'`;
  }
  if (enums.has(field.fieldType)) return `DEFAULT '${value}'`;
  return `DEFAULT '${String(value).replaceAll("'", "''")}'`;
}

const output = [
  "-- Creator Studio AI baseline migration.",
  "-- Generated from prisma/schema.prisma by infra/scripts/generate-baseline-migration.mjs.",
  "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\";",
  "",
];

for (const [name, values] of enums) {
  output.push(`CREATE TYPE ${quote(name)} AS ENUM (${values.map((value) => `'${value}'`).join(", ")});`, "");
}

const foreignKeys = [];
const indexes = [];
for (const model of modelEntries) {
  const fields = model.properties.filter(
    (item) => item.type === "field" && !models.has(item.fieldType) && !item.array,
  );
  const objectAttributes = model.properties.filter(
    (item) => item.type === "attribute" && item.kind === "object",
  );
  const compositeId = objectAttributes.find((item) => item.name === "id");
  const columnLines = fields.map((field) => {
    const pieces = [quote(field.name), sqlType(field)];
    if (!field.optional) pieces.push("NOT NULL");
    const defaultClause = defaultSql(field);
    if (defaultClause) pieces.push(defaultClause);
    if (!compositeId && attr(field, "id")) pieces.push("PRIMARY KEY");
    if (attr(field, "unique")) pieces.push("UNIQUE");
    return `  ${pieces.join(" ")}`;
  });
  if (compositeId) {
    columnLines.push(
      `  CONSTRAINT ${quote(`${model.name}_pkey`)} PRIMARY KEY (${arrayValue(compositeId).map(quote).join(", ")})`,
    );
  }
  output.push(`CREATE TABLE ${quote(model.name)} (`, columnLines.join(",\n"), ");", "");

  for (const field of model.properties.filter((item) => item.type === "field")) {
    const relation = attr(field, "relation");
    if (!relation || !models.has(field.fieldType)) continue;
    const args = keyValues(relation);
    const localFields = arrayFromKey(args.fields);
    const references = arrayFromKey(args.references);
    if (localFields.length === 0) continue;
    const onDelete = args.onDelete ?? (field.optional ? "SetNull" : "Restrict");
    const onUpdate = args.onUpdate ?? "Cascade";
    const action = (value) => {
      const mapped = {
        Cascade: "CASCADE",
        SetNull: "SET NULL",
        Restrict: "RESTRICT",
        NoAction: "NO ACTION",
        SetDefault: "SET DEFAULT",
      }[value];
      if (!mapped) throw new Error(`Unsupported referential action ${value}`);
      return mapped;
    };
    foreignKeys.push(
      `ALTER TABLE ${quote(model.name)} ADD CONSTRAINT ${quote(`${model.name}_${localFields.join("_")}_fkey`)} FOREIGN KEY (${localFields.map(quote).join(", ")}) REFERENCES ${quote(field.fieldType)} (${references.map(quote).join(", ")}) ON DELETE ${action(onDelete)} ON UPDATE ${action(onUpdate)};`,
    );
  }

  for (const objectAttribute of objectAttributes) {
    if (!["index", "unique"].includes(objectAttribute.name)) continue;
    const columns = arrayValue(objectAttribute);
    const unique = objectAttribute.name === "unique" ? "UNIQUE " : "";
    const suffix = objectAttribute.name === "unique" ? "key" : "idx";
    indexes.push(
      `CREATE ${unique}INDEX ${quote(`${model.name}_${columns.join("_")}_${suffix}`)} ON ${quote(model.name)} (${columns.map(quote).join(", ")});`,
    );
  }
}

output.push(...indexes, "", ...foreignKeys, "");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output.join("\n"));
console.log(`Generated ${outputPath}`);
