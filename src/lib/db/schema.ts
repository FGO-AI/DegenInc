import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * D1 (SQLite) schema.
 *
 * Type notes, because this is not Postgres:
 *  - ids are `text` holding a crypto.randomUUID(), generated in app code.
 *    SQLite has no gen_random_uuid().
 *  - times are `integer` Unix milliseconds, not timestamptz.
 *  - structured values (addresses) are `text` holding JSON, not jsonb.
 *  - money is integer cents. Never a float.
 *
 * Security note: there is no Row Level Security here, and SQLite has no
 * equivalent. D1 returns whatever it is asked for. Authorization lives in
 * src/lib/auth/guards.ts, and every function in src/lib/db/queries.ts must
 * call a guard before it touches these tables.
 */

/** Unix ms. Drizzle maps this to a JS Date on read. */
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/* -------------------------------------------------------------------------
   Identity
   Table is named `user` (singular) because the Better Auth Drizzle adapter
   expects that exact name. `role` is our addition.
   ------------------------------------------------------------------------- */

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),

    /**
     * Authorization is decided from this column, server side, on every
     * request. Never trust a role sent from the client.
     * member = anyone with an account; staff = back of house; owner = staff
     * plus destructive actions.
     */
    role: text("role", { enum: ["member", "staff", "owner"] })
      .notNull()
      .default("member"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("user_role_idx").on(t.role)],
);

/* -------------------------------------------------------------------------
   Catalogue
   ------------------------------------------------------------------------- */

/** One filing is one drop. */
export const filings = sqliteTable(
  "filings",
  {
    id: text("id").primaryKey(),
    /** The printed number: Filing 001. */
    number: integer("number").notNull().unique(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["draft", "scheduled", "live", "closed"],
    })
      .notNull()
      .default("draft"),
    /** Members get in at this time; everyone else at publishedAt. */
    memberPreviewAt: timestamp("member_preview_at"),
    publishedAt: timestamp("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("filings_status_idx").on(t.status),

    /**
     * At most one live filing, enforced here rather than by anyone remembering.
     *
     * getLiveFiling() puts the lowest-numbered live filing on the storefront
     * and silently ignores the rest, so a second live filing was a drop that
     * never appeared. A partial unique index covers only the rows its WHERE
     * matches: any number of drafts, scheduled or closed filings coexist, and
     * a second 'live' row fails with "UNIQUE constraint failed: filings.status"
     * — the same constraint-decides discipline as the stock CHECK below.
     * updateFilingStatus() turns that failure into a message naming the filing
     * that is still live.
     */
    uniqueIndex("filings_one_live_idx")
      .on(t.status)
      .where(sql`${t.status} = 'live'`),
  ],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    filingId: text("filing_id").references(() => filings.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /** Tee, Hood, Reserved — the label shown on the filing grid. */
    kind: text("kind").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    /** Slot order within the filing grid. */
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("products_filing_idx").on(t.filingId),
    check("products_price_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

export const productImages = sqliteTable(
  "product_images",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Object key in R2. Never a full URL — the bucket may be re-pointed. */
    r2Key: text("r2_key").notNull(),
    alt: text("alt"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("product_images_product_idx").on(t.productId)],
);

export const variants = sqliteTable(
  "variants",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    size: text("size").notNull(),
    color: text("color").notNull(),
    sku: text("sku").notNull().unique(),

    /**
     * THE important constraint in this file.
     *
     * D1 has no interactive transactions, so checkout cannot read stock,
     * decide, then write. A conditional `UPDATE ... WHERE stock >= ?` is not a
     * substitute: when it matches nothing it does not error, it changes zero
     * rows, the batch commits, and we have sold a shirt we do not have.
     *
     * So checkout decrements unconditionally and lets this CHECK fail the
     * statement. D1 rolls the whole batch back. That is what keeps a drop-time
     * stampede honest.
     */
    stock: integer("stock").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("variants_product_size_color_idx").on(
      t.productId,
      t.size,
      t.color,
    ),
    check("variants_stock_non_negative", sql`${t.stock} >= 0`),
  ],
);

/* -------------------------------------------------------------------------
   Orders
   ------------------------------------------------------------------------- */

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status", {
      enum: ["pending", "paid", "fulfilled", "cancelled", "refunded"],
    })
      .notNull()
      .default("pending"),
    subtotalCents: integer("subtotal_cents").notNull(),
    shippingCents: integer("shipping_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    /** JSON blob. SQLite has no jsonb; parse at the edges. */
    shippingAddress: text("shipping_address"),
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_user_idx").on(t.userId),
    index("orders_status_idx").on(t.status),
  ],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    /** Price at time of sale. Products get repriced; orders do not. */
    unitPriceCents: integer("unit_price_cents").notNull(),
    /** Denormalised so an order still reads correctly if the product is gone. */
    nameSnapshot: text("name_snapshot").notNull(),
    /**
     * Which variant, as a buyer reads it: "M / Black". Denormalised the same
     * way, and for the same reason — two sizes of one shirt in one order are
     * otherwise two identical lines on the receipt.
     *
     * Nullable only because SQLite cannot add a NOT NULL column without a
     * default, and a made-up default would be a lie on old receipts. Every
     * line written since this column exists has one; null means the line
     * predates it.
     */
    variantSnapshot: text("variant_snapshot"),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    check("order_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/* -------------------------------------------------------------------------
   The Collective
   ------------------------------------------------------------------------- */

/**
 * Numbered in order, non-transferable, never reused. The number comes from
 * the `counters` table inside the same batch as the insert — SQLite has no
 * sequences, and a max(number)+1 read would race under load.
 */
export const certificates = sqliteTable(
  "certificates",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull().unique(),
    /** One per member, permanently. */
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "restrict" }),
    /** The order that earned it. */
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    class: text("class").notNull().default("founding"),
    issuedAt: timestamp("issued_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [check("certificates_number_positive", sql`${t.number} > 0`)],
);

/** Open call submissions. Public writes — gate with Turnstile before wiring. */
export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    /** Name or tag, however they sign it. */
    name: text("name").notNull(),
    contact: text("contact").notNull(),
    workUrl: text("work_url").notNull(),
    note: text("note"),
    status: text("status", {
      enum: ["new", "held", "approved", "passed"],
    })
      .notNull()
      .default("new"),
    createdAt: createdAt(),
  },
  (t) => [index("submissions_status_idx").on(t.status)],
);

/** One vote per member per filing. Enforced by the unique index. */
export const votes = sqliteTable(
  "votes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    filingId: text("filing_id")
      .notNull()
      .references(() => filings.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("votes_user_filing_idx").on(t.userId, t.filingId),
    index("votes_submission_idx").on(t.submissionId),
  ],
);

/* -------------------------------------------------------------------------
   Counters
   ------------------------------------------------------------------------- */

/**
 * Monotonic counters, because SQLite has no sequences and D1 has no
 * interactive transactions.
 *
 *   UPDATE counters SET value = value + 1 WHERE name = 'certificate'
 *   RETURNING value
 *
 * runs inside the same db.batch() as the insert that consumes it, so two
 * concurrent checkouts cannot be handed the same certificate number.
 */
export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

/* -------------------------------------------------------------------------
   Better Auth tables
   ------------------------------------------------------------------------- */

/**
 * Shapes verified against Better Auth 1.7.1 by scripts/auth-schema.mjs — run
 * it after upgrading, because the field set moves between versions.
 * (`account.issuer` is required as of 1.7.1, for instance.)
 *
 * The Drizzle adapter resolves a column as schema[model][field], so the
 * PROPERTY KEYS below must match Better Auth's field names exactly (camelCase).
 * The database column names are ours to choose, so they stay snake_case like
 * the rest of the schema.
 */

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    /** Hashed by Better Auth. Null for OAuth-only accounts. */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
