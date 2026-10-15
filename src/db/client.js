import { createClient } from "@libsql/client";

const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } = process.env;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
}

export const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});

// price_rub / amount_rub are retained for compatibility with the existing DB.
// New bot code uses price_stars / amount_stars exclusively.
const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    terms_accepted INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    protocol TEXT NOT NULL,
    price_rub INTEGER NOT NULL CHECK (price_rub > 0),
    price_stars INTEGER NOT NULL DEFAULT 19 CHECK (price_stars > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    config_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available'
      CHECK (status IN ('available', 'reserved', 'sold')),
    order_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    amount_rub INTEGER NOT NULL CHECK (amount_rub > 0),
    amount_stars INTEGER NOT NULL DEFAULT 19 CHECK (amount_stars > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'delivered', 'cancelled')),
    config_id INTEGER UNIQUE REFERENCES configs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    delivered_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
    provider_payment_id TEXT UNIQUE,
    idempotence_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    confirmation_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    telegram_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)`,
  `CREATE INDEX IF NOT EXISTS idx_configs_stock ON configs(product_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(telegram_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_sessions_updated ON admin_sessions(updated_at)`
];

async function getColumnNames(tableName) {
  const result = await db.execute(`PRAGMA table_info(${tableName})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function ensureColumn(tableName, columnName, definition, legacyColumn) {
  const columns = await getColumnNames(tableName);

  if (columns.has(columnName)) return;

  await db.execute(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
  );

  if (legacyColumn && columns.has(legacyColumn)) {
    // This migration runs only once, when the new column is first added.
    await db.execute(
      `UPDATE ${tableName} SET ${columnName} = ${legacyColumn}`
    );
  }
}

let initPromise;

export function initDatabase() {
  if (!initPromise) {
    initPromise = (async () => {
      for (const sql of schema) {
        await db.execute(sql);
      }

      // Safe, one-time migrations for databases created before Stars support.
      await ensureColumn(
        "users",
        "terms_accepted",
        "INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1))"
      );
      await ensureColumn(
        "products",
        "price_stars",
        "INTEGER NOT NULL DEFAULT 19 CHECK (price_stars > 0)",
        "price_rub"
      );
      await ensureColumn(
        "orders",
        "amount_stars",
        "INTEGER NOT NULL DEFAULT 19 CHECK (amount_stars > 0)",
        "amount_rub"
      );
    })().catch((error) => {
      initPromise = undefined;
      throw error;
    });
  }

  return initPromise;
}
