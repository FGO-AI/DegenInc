/**
 * Prints Better Auth's authoritative table/field spec as JSON.
 *
 * Why this exists: `better-auth generate` imports the auth instance from a
 * config file and expects a plain object. Ours is an async singleton, because
 * the D1 binding only exists per request — so the CLI cannot load it. This
 * asks the core library for the same spec the CLI would use, and we mirror it
 * by hand in src/lib/db/schema.ts.
 *
 * Run: node scripts/auth-schema.mjs
 */
import { getAuthTables } from "@better-auth/core/db";

const tables = getAuthTables({
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "member" },
    },
  },
});

const out = {};
for (const [key, table] of Object.entries(tables)) {
  out[key] = {
    modelName: table.modelName,
    fields: Object.fromEntries(
      Object.entries(table.fields).map(([name, f]) => [
        name,
        {
          column: f.fieldName ?? name,
          type: f.type,
          required: f.required ?? false,
          unique: f.unique ?? false,
          references: f.references
            ? `${f.references.model}.${f.references.field} onDelete=${f.references.onDelete}`
            : undefined,
        },
      ]),
    ),
  };
}
console.log(JSON.stringify(out, null, 2));
