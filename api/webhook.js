import { db, initDatabase } from "../src/db/client.js";
import {
  telegram,
  sendMessage,
  answerCallbackQuery,
  downloadTelegramFile
} from "../src/bot/telegram.js";
import {
  createStarOrder,
  cancelStarOrder,
  validateStarPreCheckout,
  processSuccessfulStarPayment,
  completeTestStarOrder
} from "../src/payments/stars.js";

const adminIds = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const MAX_CONFIGS_PER_UPLOAD = 500;
const MAX_CONFIG_LENGTH = 4096;
const MAX_STAR_PRICE = 100000;
const TELEGRAM_MESSAGE_LIMIT = 4096;

function isPaymentsTestMode() {
  return String(process.env.PAYMENTS_TEST_MODE || "").toLowerCase() === "true";
}

const EDIT_FIELDS = {
  name: {
    column: "name",
    label: "название",
    prompt: "Введи новое название товара:"
  },
  country: {
    column: "country",
    label: "страну",
    prompt: "Введи новую страну:"
  },
  protocol: {
    column: "protocol",
    label: "протокол",
    prompt: "Введи новый протокол:"
  },
  price: {
    column: "price_stars",
    label: "цену в звёздах",
    prompt: "Введи новую цену в целых звёздах, например 19:"
  }
};

function isAdmin(telegramId) {
  return adminIds.has(String(telegramId));
}

function mainMenu(telegramId) {
  const rows = [
    [{ text: "🛒 Купить конфиг", callback_data: "catalog" }],
    [{ text: "👤 Мои покупки", callback_data: "my_orders" }],
    [{ text: "📜 Условия покупки", callback_data: "terms:show" }],
    [{ text: "🆘 Поддержка", callback_data: "support:start" }]
  ];

  if (isAdmin(telegramId)) {
    rows.push([{ text: "🛠 Админ-панель", callback_data: "admin:home" }]);
  }

  return { inline_keyboard: rows };
}

function cancelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✖️ Отмена", callback_data: "admin:cancel" }]
    ]
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Создать товар", callback_data: "admin:new" }],
      [{ text: "📝 Управление товарами", callback_data: "admin:products" }],
      [{ text: "📦 Склад конфигов", callback_data: "admin:stock" }],
      [{ text: "🏠 Главное меню", callback_data: "home" }]
    ]
  };
}

async function editMessage(chatId, messageId, text, replyMarkup, parseMode) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  } catch (error) {
    if (String(error).includes("message is not modified")) return null;
    throw error;
  }
}

async function render(chatId, messageId, text, keyboard) {
  if (messageId) return editMessage(chatId, messageId, text, keyboard);
  return sendMessage(chatId, text, keyboard);
}

// The invoice is a separate Telegram service message, so save the product-card
// message id to be able to replace that card after the payment succeeds.
async function initCheckoutMessageStorage() {
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS order_checkout_messages (
      order_id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  });
}

async function saveCheckoutMessage(orderId, chatId, messageId) {
  await db.execute({
    sql: `INSERT INTO order_checkout_messages (order_id, chat_id, message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        message_id = excluded.message_id`,
    args: [Number(orderId), String(chatId), Number(messageId)]
  });
}

async function getCheckoutMessage(orderId) {
  const result = await db.execute({
    sql: `SELECT chat_id, message_id
      FROM order_checkout_messages WHERE order_id = ?`,
    args: [Number(orderId)]
  });
  return result.rows[0] || null;
}

async function deleteCheckoutMessage(orderId) {
  await db.execute({
    sql: "DELETE FROM order_checkout_messages WHERE order_id = ?",
    args: [Number(orderId)]
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function purchaseKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛒 В каталог", callback_data: "catalog" }],
      [{ text: "🏠 В меню", callback_data: "home" }]
    ]
  };
}

async function sendHtmlMessage(chatId, text, replyMarkup) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function saveSession(telegramId, action, data, chatId, messageId) {
  await db.execute({
    sql: `
      INSERT INTO admin_sessions
        (telegram_id, action, data_json, chat_id, message_id, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(telegram_id) DO UPDATE SET
        action = excluded.action,
        data_json = excluded.data_json,
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        updated_at = datetime('now')
    `,
    args: [
      String(telegramId),
      action,
      JSON.stringify(data || {}),
      String(chatId),
      Number(messageId)
    ]
  });
}

async function getSession(telegramId) {
  const result = await db.execute({
    sql: `SELECT action, data_json, chat_id, message_id
      FROM admin_sessions WHERE telegram_id = ?`,
    args: [String(telegramId)]
  });

  const row = result.rows[0];
  if (!row) return null;

  let data = {};
  try {
    data = JSON.parse(row.data_json || "{}");
  } catch {
    data = {};
  }

  return {
    action: row.action,
    data,
    chatId: row.chat_id,
    messageId: Number(row.message_id)
  };
}

async function clearSession(telegramId) {
  await db.execute({
    sql: "DELETE FROM admin_sessions WHERE telegram_id = ?",
    args: [String(telegramId)]
  });
}

async function showHome(chatId, messageId, telegramId) {
  await render(
    chatId,
    messageId,
    "🚀 VPN Config Shop\n\nВыбирай нужный раздел. Оплата — Telegram Stars ⭐",
    mainMenu(telegramId)
  );
}

async function showAdminPanel(chatId, messageId) {
  await render(
    chatId,
    messageId,
    "🛠 Админ-панель\n\n" +
      "Управляй товарами и складом конфигов.\n" +
      "Покупатели оплачивают конфиги звёздами Telegram ⭐" +
      (isPaymentsTestMode() ? "\n\n🧪 ТЕСТОВЫЙ РЕЖИМ ВКЛЮЧЁН: тестовая выдача без списания звёзд доступна только администратору." : ""),
    adminKeyboard()
  );
}

async function showTerms(chatId, messageId, productId = 0) {
  const acceptCallback = `terms:accept:${Number(productId) || 0}`;
  await render(
    chatId,
    messageId,
    "📜 Условия покупки\n\n" +
      "• Продаётся цифровой VPN-конфиг, а не физический товар.\n" +
      "• После подтверждения оплаты бот отправит один конфиг из наличия.\n" +
      "• Совместимость зависит от VPN-клиента и устройства покупателя.\n" +
      "• Если оплата прошла, но конфиг не пришёл, нажми «Поддержка» в меню.\n" +
      "• Нажимая «Принимаю условия», ты подтверждаешь, что прочитал эти условия.",
    {
      inline_keyboard: [
        [{ text: "✅ Принимаю условия", callback_data: acceptCallback }],
        [{ text: "⬅️ В меню", callback_data: "home" }]
      ]
    }
  );
}

async function hasAcceptedTerms(telegramId) {
  const result = await db.execute({
    sql: "SELECT terms_accepted FROM users WHERE telegram_id = ?",
    args: [String(telegramId)]
  });
  return Number(result.rows[0]?.terms_accepted) === 1;
}

async function acceptTerms(telegramId) {
  await db.execute({
    sql: `INSERT INTO users (telegram_id, terms_accepted)
      VALUES (?, 1)
      ON CONFLICT(telegram_id) DO UPDATE SET terms_accepted = 1`,
    args: [String(telegramId)]
  });
}

async function showCatalog(chatId, messageId = null) {
  const result = await db.execute({
    sql: `SELECT p.id, p.name, p.price_stars,
        COUNT(c.id) AS stock
      FROM products p
      LEFT JOIN configs c
        ON c.product_id = p.id AND c.status = 'available'
      WHERE p.active = 1
      GROUP BY p.id
      ORDER BY p.id DESC`
  });

  if (!result.rows.length) {
    await render(chatId, messageId, "🛒 Каталог\n\n📦 Пока товаров нет.", {
      inline_keyboard: [[{ text: "⬅️ В меню", callback_data: "home" }]]
    });
    return;
  }

  const keyboard = result.rows.map((product) => {
    const stock = Number(product.stock);
    return [{
      text: stock > 0
        ? `${product.name} — ⭐ ${product.price_stars} · ${stock} шт.`
        : `${product.name} — нет в наличии`,
      callback_data: `product:${product.id}`
    }];
  });

  keyboard.push([{ text: "⬅️ В меню", callback_data: "home" }]);
  await render(
    chatId,
    messageId,
    "🛒 Каталог конфигов\n\nВыбери предложение:",
    { inline_keyboard: keyboard }
  );
}

async function showPublicProduct(chatId, productId, messageId, telegramId = null) {
  const result = await db.execute({
    sql: `SELECT p.*,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS stock
      FROM products p
      WHERE p.id = ? AND p.active = 1`,
    args: [productId]
  });
  const product = result.rows[0];

  if (!product) {
    await render(chatId, messageId, "❌ Товар не найден или отключён.", {
      inline_keyboard: [[{ text: "⬅️ В каталог", callback_data: "catalog" }]]
    });
    return;
  }

  const stock = Number(product.stock);
  const keyboard = [];
  if (stock > 0 && !isPaymentsTestMode()) {
    keyboard.push([{
      text: `⭐ Купить за ${product.price_stars} Stars`,
      callback_data: `buy:${product.id}`
    }]);
  }
  if (stock > 0 && isPaymentsTestMode() && isAdmin(telegramId)) {
    keyboard.push([{
      text: "🧪 Тестовая выдача (без оплаты)",
      callback_data: `testbuy:${product.id}`
    }]);
  }
  keyboard.push([{ text: "⬅️ Назад в каталог", callback_data: "catalog" }]);
  keyboard.push([{ text: "🏠 В меню", callback_data: "home" }]);

  await render(
    chatId,
    messageId,
    `🌐 ${product.name}\n\n` +
      `🌍 Страна: ${product.country}\n` +
      `🔌 Протокол: ${product.protocol}\n` +
      `💰 Цена: ⭐ ${product.price_stars}\n` +
      `📦 В наличии: ${stock}\n\n` +
      (stock <= 0
        ? "Сейчас конфигов нет в наличии."
        : isPaymentsTestMode()
          ? (isAdmin(telegramId)
            ? "🧪 Включён тестовый режим: реальная оплата отключена. Используй тестовую выдачу ниже."
            : "⏸️ Магазин временно в режиме тестирования. Реальная оплата отключена.")
          : "После успешной оплаты бот автоматически пришлёт один конфиг."),
    { inline_keyboard: keyboard }
  );
}

async function showMyOrders(chatId, messageId, telegramId) {
  const result = await db.execute({
    sql: `SELECT o.id, o.amount_stars, o.status, o.created_at, p.name,
        pay.status AS payment_status
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN payments pay ON pay.order_id = o.id
      WHERE o.telegram_id = ?
      ORDER BY o.id DESC LIMIT 10`,
    args: [String(telegramId)]
  });

  if (!result.rows.length) {
    await render(chatId, messageId, "👤 Мои покупки\n\nПока покупок нет.", {
      inline_keyboard: [
        [{ text: "🛒 Открыть каталог", callback_data: "catalog" }],
        [{ text: "⬅️ В меню", callback_data: "home" }]
      ]
    });
    return;
  }

  const statusLabels = {
    pending: "⏳ ожидает оплаты",
    paid: "⚠️ оплачен, нужна проверка",
    delivered: "✅ конфиг выдан",
    cancelled: "✖️ отменён"
  };
  const text = result.rows.map((order) => {
    const status = order.payment_status === "test"
      ? "🧪 тестовая выдача (звёзды не списывались)"
      : (statusLabels[order.status] || order.status);
    return `#${order.id} · ${order.name}\n⭐ ${order.amount_stars} · ${status}\n${order.created_at}`;
  }).join("\n\n");

  await render(chatId, messageId, `👤 Последние покупки\n\n${text}`, {
    inline_keyboard: [
      [{ text: "🛒 Каталог", callback_data: "catalog" }],
      [{ text: "⬅️ В меню", callback_data: "home" }]
    ]
  });
}

async function showAdminProducts(chatId, messageId) {
  const result = await db.execute({
    sql: `SELECT p.id, p.name, p.price_stars, p.active,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS stock
      FROM products p ORDER BY p.id DESC`
  });

  if (!result.rows.length) {
    await render(chatId, messageId, "📝 Товаров пока нет. Создай первый товар!", {
      inline_keyboard: [
        [{ text: "➕ Создать товар", callback_data: "admin:new" }],
        [{ text: "⬅️ В админку", callback_data: "admin:home" }]
      ]
    });
    return;
  }

  const keyboard = result.rows.map((product) => [{
    text: `${product.active ? "🟢" : "⚪"} ${product.name} · ⭐ ${product.price_stars} · ${Number(product.stock)} шт.`,
    callback_data: `admin:product:${product.id}`
  }]);
  keyboard.push([{ text: "➕ Создать товар", callback_data: "admin:new" }]);
  keyboard.push([{ text: "⬅️ В админку", callback_data: "admin:home" }]);

  await render(chatId, messageId,
    "📝 Управление товарами\n\n🟢 — активен\n⚪ — отключён\n\nВыбери товар:",
    { inline_keyboard: keyboard }
  );
}

async function getAdminProduct(productId) {
  const result = await db.execute({
    sql: `SELECT p.*,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'available') AS available_stock,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'sold') AS sold_stock,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'reserved') AS reserved_stock
      FROM products p WHERE p.id = ?`,
    args: [productId]
  });
  return result.rows[0] || null;
}

async function showAdminProduct(chatId, messageId, productId) {
  const product = await getAdminProduct(productId);
  if (!product) {
    await render(chatId, messageId, "❌ Товар не найден.", {
      inline_keyboard: [[{ text: "⬅️ К товарам", callback_data: "admin:products" }]]
    });
    return;
  }

  await render(
    chatId,
    messageId,
    `📝 Товар #${product.id}\n\n` +
      `Название: ${product.name}\n` +
      `Страна: ${product.country}\n` +
      `Протокол: ${product.protocol}\n` +
      `Цена: ⭐ ${product.price_stars}\n` +
      `Статус: ${product.active ? "🟢 активен" : "⚪ отключён"}\n\n` +
      `📦 В наличии: ${Number(product.available_stock)}\n` +
      `🧾 Продано: ${Number(product.sold_stock)}\n` +
      `⏳ Зарезервировано: ${Number(product.reserved_stock)}`,
    {
      inline_keyboard: [
        [
          { text: "✏️ Название", callback_data: `admin:edit:${product.id}:name` },
          { text: "🌍 Страна", callback_data: `admin:edit:${product.id}:country` }
        ],
        [
          { text: "🔌 Протокол", callback_data: `admin:edit:${product.id}:protocol` },
          { text: "⭐ Цена", callback_data: `admin:edit:${product.id}:price` }
        ],
        [{ text: "📥 Добавить конфиги", callback_data: `admin:addstock:${product.id}` }],
        [{ text: "📦 Управление складом", callback_data: `admin:stockprod:${product.id}` }],
        [{
          text: product.active ? "⏸ Отключить товар" : "▶️ Включить товар",
          callback_data: `admin:toggle:${product.id}`
        }],
        [{ text: "⬅️ К товарам", callback_data: "admin:products" }],
        [{ text: "🏠 В админку", callback_data: "admin:home" }]
      ]
    }
  );
}

async function showStock(chatId, messageId) {
  const result = await db.execute({
    sql: `SELECT p.id, p.name, p.active,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'available') AS available_stock,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'sold') AS sold_stock,
        (SELECT COUNT(*) FROM configs c WHERE c.product_id = p.id AND c.status = 'reserved') AS reserved_stock
      FROM products p ORDER BY p.id DESC`
  });

  if (!result.rows.length) {
    await render(chatId, messageId, "📦 Склад пуст — сначала создай товар.", {
      inline_keyboard: [
        [{ text: "➕ Создать товар", callback_data: "admin:new" }],
        [{ text: "⬅️ В админку", callback_data: "admin:home" }]
      ]
    });
    return;
  }

  const keyboard = result.rows.map((product) => [{
    text: `${product.name} · ${Number(product.available_stock)} доступно`,
    callback_data: `admin:stockprod:${product.id}`
  }]);
  keyboard.push([{ text: "⬅️ В админку", callback_data: "admin:home" }]);

  const summary = result.rows.map((product) =>
    `${product.name}\n  Доступно: ${Number(product.available_stock)} · ` +
    `Продано: ${Number(product.sold_stock)} · ` +
    `Резерв: ${Number(product.reserved_stock)}`
  ).join("\n\n");

  await render(chatId, messageId,
    `📦 Склад конфигов\n\n${summary}\n\nВыбери товар для подробностей:`,
    { inline_keyboard: keyboard }
  );
}

async function showStockProduct(chatId, messageId, productId) {
  const product = await getAdminProduct(productId);
  if (!product) {
    await showStock(chatId, messageId);
    return;
  }

  await render(
    chatId,
    messageId,
    `📦 Склад: ${product.name}\n\n` +
      `Доступно: ${Number(product.available_stock)}\n` +
      `Продано: ${Number(product.sold_stock)}\n` +
      `Зарезервировано: ${Number(product.reserved_stock)}\n\n` +
      "Добавление конфигов поддерживает текстовые URI и файлы .txt.",
    {
      inline_keyboard: [
        [{ text: "📥 Добавить конфиги", callback_data: `admin:addstock:${product.id}` }],
        [{ text: "📝 Карточка товара", callback_data: `admin:product:${product.id}` }],
        [{ text: "⬅️ К складу", callback_data: "admin:stock" }],
        [{ text: "🏠 В админку", callback_data: "admin:home" }]
      ]
    }
  );
}

async function beginSession(telegramId, chatId, messageId, action, data, prompt) {
  await saveSession(telegramId, action, data, chatId, messageId);
  await editMessage(chatId, messageId, prompt, cancelKeyboard());
}

async function beginStockUpload(telegramId, chatId, messageId, productId) {
  const product = await getAdminProduct(productId);
  if (!product) {
    await render(chatId, messageId, "❌ Товар не найден.", {
      inline_keyboard: [[{ text: "⬅️ К складу", callback_data: "admin:stock" }]]
    });
    return;
  }

  await beginSession(
    telegramId,
    chatId,
    messageId,
    "add_stock",
    { productId },
    `📥 Загрузка конфигов: ${product.name}\n\n` +
      "Отправь один или несколько URI текстом, каждый с новой строки, либо файл .txt.\n\n" +
      "Поддерживаются VLESS, VMess, Trojan, Shadowsocks, SOCKS и Hysteria2.\n" +
      "Пустые строки и строки-комментарии, начинающиеся с #, игнорируются.\n\n" +
      `Максимум за одну загрузку: ${MAX_CONFIGS_PER_UPLOAD} конфигов.`
  );
}

function parseConfigLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isValidConfigUri(value) {
  return value.length <= MAX_CONFIG_LENGTH &&
    /^(vless|vmess|trojan|ss|socks|socks5|hysteria|hysteria2|hy2):\/\/\S+$/i.test(value);
}

async function importConfigs(productId, content) {
  const lines = parseConfigLines(content);
  if (!lines.length) {
    return { inserted: 0, duplicates: 0, invalid: 0, message: "Файл или сообщение не содержит конфигов." };
  }

  if (lines.length > MAX_CONFIGS_PER_UPLOAD) {
    throw new Error(`Слишком много строк: максимум ${MAX_CONFIGS_PER_UPLOAD} конфигов за загрузку.`);
  }

  const productResult = await db.execute({
    sql: "SELECT id FROM products WHERE id = ?",
    args: [productId]
  });
  if (!productResult.rows.length) throw new Error("Товар не найден.");

  let inserted = 0;
  let duplicates = 0;
  let invalid = 0;
  const seen = new Set();

  for (const config of lines) {
    if (!isValidConfigUri(config)) {
      invalid++;
      continue;
    }
    if (seen.has(config)) {
      duplicates++;
      continue;
    }
    seen.add(config);

    const existing = await db.execute({
      sql: "SELECT id FROM configs WHERE config_text = ? LIMIT 1",
      args: [config]
    });
    if (existing.rows.length) {
      duplicates++;
      continue;
    }

    await db.execute({
      sql: "INSERT INTO configs (product_id, config_text, status) VALUES (?, ?, 'available')",
      args: [productId, config]
    });
    inserted++;
  }

  return { inserted, duplicates, invalid };
}

async function handleAdminInput(message, session) {
  const telegramId = message.from.id;
  const chatId = session.chatId;
  const messageId = session.messageId;
  const text = (message.text || "").trim();
  const data = session.data || {};

  if (session.action === "add_stock") {
    let content;

    if (message.document) {
      const document = message.document;
      const filename = (document.file_name || "").toLowerCase();
      if (!filename.endsWith(".txt") && document.mime_type !== "text/plain") {
        await editMessage(chatId, messageId,
          "❌ Отправь текстовый файл .txt или вставь URI сообщением.", cancelKeyboard());
        return;
      }

      try {
        content = await downloadTelegramFile(document.file_id);
      } catch (error) {
        await editMessage(chatId, messageId,
          `❌ Не удалось прочитать файл: ${error.message}\n\nПопробуй ещё раз.`, cancelKeyboard());
        return;
      }
    } else if (text) {
      content = text;
    } else {
      await editMessage(chatId, messageId, "Отправь URI текстом или файл .txt.", cancelKeyboard());
      return;
    }

    try {
      const result = await importConfigs(data.productId, content);
      await clearSession(telegramId);
      const summary = `✅ Загрузка завершена\n\n` +
        `Добавлено: ${result.inserted}\n` +
        `Дубликатов: ${result.duplicates}\n` +
        `Некорректных строк: ${result.invalid}` +
        (result.message ? `\n\n${result.message}` : "");

      await render(chatId, messageId, summary, {
        inline_keyboard: [
          [{ text: "📥 Добавить ещё", callback_data: `admin:addstock:${data.productId}` }],
          [{ text: "📦 К складу товара", callback_data: `admin:stockprod:${data.productId}` }],
          [{ text: "🛠 В админку", callback_data: "admin:home" }]
        ]
      });
    } catch (error) {
      await editMessage(chatId, messageId,
        `❌ Ошибка загрузки: ${error.message}\n\nПопробуй ещё раз.`, cancelKeyboard());
    }
    return;
  }

  if (message.document) {
    await editMessage(chatId, messageId, "Для этого шага нужен текст. Отправь значение сообщением.", cancelKeyboard());
    return;
  }

  if (!text) {
    await editMessage(chatId, messageId, "Отправь значение текстом.", cancelKeyboard());
    return;
  }

  if (session.action === "create_name") {
    if (text.length > 80) {
      await editMessage(chatId, messageId, "Название слишком длинное. Максимум 80 символов.", cancelKeyboard());
      return;
    }
    await saveSession(telegramId, "create_country", { name: text }, chatId, messageId);
    await editMessage(chatId, messageId, "🌍 Введи страну сервера:", cancelKeyboard());
    return;
  }

  if (session.action === "create_country") {
    if (text.length > 60) {
      await editMessage(chatId, messageId, "Название страны слишком длинное. Максимум 60 символов.", cancelKeyboard());
      return;
    }
    await saveSession(telegramId, "create_protocol", { ...data, country: text }, chatId, messageId);
    await editMessage(chatId, messageId, "🔌 Введи название протокола (например, VLESS Reality):", cancelKeyboard());
    return;
  }

  if (session.action === "create_protocol") {
    if (text.length > 40) {
      await editMessage(chatId, messageId, "Название протокола слишком длинное. Максимум 40 символов.", cancelKeyboard());
      return;
    }
    await saveSession(telegramId, "create_price", { ...data, protocol: text }, chatId, messageId);
    await editMessage(chatId, messageId, `⭐ Введи цену в целых звёздах (от 1 до ${MAX_STAR_PRICE}), например 19:`, cancelKeyboard());
    return;
  }

  if (session.action === "create_price") {
    const price = Number(text);
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_STAR_PRICE) {
      await editMessage(chatId, messageId,
        `❌ Цена должна быть целым числом от 1 до ${MAX_STAR_PRICE} Stars. Попробуй ещё раз:`, cancelKeyboard());
      return;
    }

    const result = await db.execute({
      sql: `INSERT INTO products (name, country, protocol, price_rub, price_stars, active)
        VALUES (?, ?, ?, ?, ?, 1)`,
      args: [data.name, data.country, data.protocol, price, price]
    });
    const productId = Number(result.lastInsertRowid);
    await clearSession(telegramId);

    await render(chatId, messageId,
      `✅ Товар создан!\n\nНазвание: ${data.name}\nСтрана: ${data.country}\n` +
      `Протокол: ${data.protocol}\nЦена: ⭐ ${price}\n\nТеперь можно загрузить конфиги на склад.`,
      {
        inline_keyboard: [
          [{ text: "📥 Добавить конфиги", callback_data: `admin:addstock:${productId}` }],
          [{ text: "📝 Открыть товар", callback_data: `admin:product:${productId}` }],
          [{ text: "🛠 В админку", callback_data: "admin:home" }]
        ]
      }
    );
    return;
  }

  if (session.action === "edit_product") {
    const field = EDIT_FIELDS[data.field];
    if (!field) {
      await clearSession(telegramId);
      await showAdminPanel(chatId, messageId);
      return;
    }

    let value = text;
    if (data.field === "price") {
      value = Number(text);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STAR_PRICE) {
        await editMessage(chatId, messageId,
          `❌ Цена должна быть целым числом от 1 до ${MAX_STAR_PRICE} Stars. Попробуй ещё раз:`, cancelKeyboard());
        return;
      }
    } else if (text.length > (data.field === "name" ? 80 : data.field === "protocol" ? 40 : 60)) {
      await editMessage(chatId, messageId, "❌ Значение слишком длинное. Попробуй ещё раз:", cancelKeyboard());
      return;
    }

    await db.execute({
      sql: `UPDATE products SET ${field.column} = ? WHERE id = ?`,
      args: [value, data.productId]
    });
    await clearSession(telegramId);
    await showAdminProduct(chatId, messageId, data.productId);
  }
}

async function beginSupport(chatId, telegramId, messageId) {
  await saveSession(telegramId, "user_support", {}, chatId, messageId);
  await sendMessage(chatId,
    "🆘 Поддержка\n\nНапиши одним сообщением, что случилось. Я передам обращение администратору. Чтобы отменить, отправь /cancel.");
}

async function forwardSupportMessage(message) {
  const user = message.from || {};
  const username = user.username ? `@${user.username}` : "без username";
  const content = String(message.text || "").trim().slice(0, 3500);
  const report = `📨 Обращение в поддержку\nПользователь: ${user.first_name || ""} ${username}\nID: ${user.id}\n\n${content}`;

  for (const adminId of adminIds) {
    try {
      await sendMessage(adminId, report);
    } catch (error) {
      console.error("Could not forward support message to admin:", error);
    }
  }
}

async function notifyAdminsAboutPaidOrder(orderId, telegramId, stars) {
  const text = `⚠️ Оплата Stars получена, но конфиг не удалось выдать автоматически.\n` +
    `Заказ: #${orderId}\nПокупатель ID: ${telegramId}\nСумма: ⭐ ${stars}\n` +
    "Проверь заказ и свяжись с покупателем.";
  for (const adminId of adminIds) {
    try {
      await sendMessage(adminId, text);
    } catch (error) {
      console.error("Could not notify admin about paid order:", error);
    }
  }
}

async function handleTestPurchase(chatId, productId, telegramId, messageId = null) {
  if (!isAdmin(telegramId) || !isPaymentsTestMode()) {
    await sendMessage(chatId, "⛔ Тестовая выдача отключена или у тебя нет доступа.");
    return;
  }

  let order;
  try {
    order = await createStarOrder(productId, telegramId);
    const result = await completeTestStarOrder(order.orderId, telegramId);

    if (!result.fulfilled || !result.configText) {
      throw new Error("Не удалось завершить тестовую выдачу.");
    }

    const summary =
      `🧪 <b>ТЕСТОВАЯ ПОКУПКА УСПЕШНА</b>\n\n` +
      `Заказ: <b>#${result.orderId}</b>\n` +
      `Цена для проверки: ⭐ ${order.stars}\n` +
      "Реальные звёзды НЕ списывались. Конфиг возвращён на склад после теста.";
    const fullText = `${summary}\n\n<pre>${escapeHtml(result.configText)}</pre>`;
    const canFitConfig = result.configText.length + summary.length + 20 <= TELEGRAM_MESSAGE_LIMIT;
    let edited = false;

    if (messageId) {
      try {
        await editMessage(
          chatId,
          messageId,
          canFitConfig ? fullText : summary,
          purchaseKeyboard(),
          "HTML"
        );
        edited = true;
      } catch (error) {
        console.error("Could not edit test purchase product card:", error);
      }
    }

    if (!edited) {
      await sendHtmlMessage(chatId, canFitConfig ? fullText : summary, purchaseKeyboard());
    }
    if (!canFitConfig) {
      await sendHtmlMessage(chatId, `<pre>${escapeHtml(result.configText)}</pre>`);
    }
  } catch (error) {
    if (order?.orderId) {
      try {
        await cancelStarOrder(order.orderId);
      } catch (cancelError) {
        console.error("Could not release failed test order:", cancelError);
      }
    }
    console.error("Test purchase failed:", error);
    await sendMessage(chatId, "❌ Не удалось выполнить тест. Проверь, что товар активен и на складе есть конфиги.");
  }
}

async function handleSuccessfulPayment(message) {
  const chatId = message.chat.id;
  const result = await processSuccessfulStarPayment(message);

  if (!result.fulfilled || !result.configText) {
    await sendMessage(chatId,
      `✅ Платёж по заказу #${result.orderId} получен, но автоматическая выдача не завершилась. ` +
      "Администратор уведомлён — не оплачивай повторно.");
    await notifyAdminsAboutPaidOrder(
      result.orderId,
      message.from.id,
      message.successful_payment.total_amount
    );
    return;
  }

  const stars = Number(message.successful_payment?.total_amount || 0);
  const summary =
    `✅ <b>Оплата прошла успешно!</b>\n\n` +
    `Заказ: <b>#${result.orderId}</b>\n` +
    `Оплачено: <b>⭐ ${stars}</b>`;
  const configBlock = `<pre>${escapeHtml(result.configText)}</pre>`;
  const fullText = `${summary}\n\nТвой VPN-конфиг:\n${configBlock}`;
  // Telegram has a 4096-character post-parse limit. Very long configs are sent
  // in their own code block while the original product card becomes the receipt.
  const canFitConfig = result.configText.length + summary.length + 40 <= TELEGRAM_MESSAGE_LIMIT;
  const cardText = canFitConfig ? fullText : summary;
  const keyboard = purchaseKeyboard();
  let checkout = null;

  try {
    checkout = await getCheckoutMessage(result.orderId);
  } catch (error) {
    console.error("Could not load checkout product card:", error);
  }

  let edited = false;
  if (checkout?.message_id) {
    try {
      await editMessage(
        checkout.chat_id || chatId,
        Number(checkout.message_id),
        cardText,
        keyboard,
        "HTML"
      );
      edited = true;
    } catch (error) {
      console.error("Could not edit product card after payment:", error);
    }
  }

  if (!edited) {
    await sendHtmlMessage(chatId, cardText, keyboard);
  }

  if (!canFitConfig) {
    await sendHtmlMessage(chatId, configBlock);
  }

  try {
    await deleteCheckoutMessage(result.orderId);
  } catch (error) {
    console.error("Could not delete checkout message mapping:", error);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const secret = process.env.WEBHOOK_SECRET;
  const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (!secret || typeof receivedSecret !== "string" || receivedSecret !== secret) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await initDatabase();
    await initCheckoutMessageStorage();
    const update = req.body;

    if (update?.pre_checkout_query) {
      const query = update.pre_checkout_query;
      const validation = await validateStarPreCheckout(query);
      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id: query.id,
        ok: validation.ok,
        ...(validation.ok ? {} : { error_message: validation.errorMessage })
      });
      return res.status(200).json({ ok: true });
    }

    if (update?.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const telegramId = message.from?.id;
      const text = (message.text || "").trim();

      if (telegramId) {
        await db.execute({
          sql: `INSERT INTO users (telegram_id)
            VALUES (?) ON CONFLICT(telegram_id) DO NOTHING`,
          args: [String(telegramId)]
        });
      }

      if (message.successful_payment) {
        await handleSuccessfulPayment(message);
        return res.status(200).json({ ok: true });
      }

      if (text === "/cancel") {
        if (telegramId) {
          const session = await getSession(telegramId);
          await clearSession(telegramId);
          if (session && isAdmin(telegramId)) {
            await showAdminPanel(session.chatId, session.messageId);
          } else {
            await sendMessage(chatId, "Операция отменена.", mainMenu(telegramId));
          }
        } else {
          await sendMessage(chatId, "Нет активной операции.");
        }
      } else if (text === "/start") {
        if (telegramId) await clearSession(telegramId);
        await showHome(chatId, null, telegramId);
      } else if (text === "/terms") {
        await showTerms(chatId, null, 0);
      } else if (text === "/support" || text === "/paysupport") {
        if (isAdmin(telegramId)) {
          await sendMessage(chatId, "Ты администратор. Обращения покупателей будут приходить сюда.");
        } else {
          await beginSupport(chatId, telegramId, message.message_id);
        }
      } else if (text === "/catalog") {
        if (telegramId) await clearSession(telegramId);
        await showCatalog(chatId);
      } else if (text === "/admin") {
        if (!isAdmin(telegramId)) {
          await sendMessage(chatId, "⛔ Нет доступа к админ-панели.");
        } else {
          await clearSession(telegramId);
          await showAdminPanel(chatId, null);
        }
      } else if (telegramId && isAdmin(telegramId)) {
        const session = await getSession(telegramId);
        if (session && session.action !== "user_support") {
          await handleAdminInput(message, session);
        } else {
          await sendMessage(chatId, "Используй меню ниже 👇", mainMenu(telegramId));
        }
      } else if (telegramId) {
        const session = await getSession(telegramId);
        if (session?.action === "user_support") {
          if (!text) {
            await sendMessage(chatId, "Отправь обращение текстом или /cancel для отмены.");
          } else {
            await forwardSupportMessage(message);
            await clearSession(telegramId);
            await sendMessage(chatId, "✅ Обращение отправлено администратору.", mainMenu(telegramId));
          }
        } else {
          await sendMessage(chatId, "Используй меню ниже 👇", mainMenu(telegramId));
        }
      }
    }

    if (update?.callback_query) {
      const query = update.callback_query;
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      const telegramId = query.from?.id;
      const data = query.data || "";

      if (!chatId || !messageId) {
        await answerCallbackQuery(query.id);
        return res.status(200).json({ ok: true });
      }

      if (telegramId) {
        await db.execute({
          sql: `INSERT INTO users (telegram_id)
            VALUES (?) ON CONFLICT(telegram_id) DO NOTHING`,
          args: [String(telegramId)]
        });
      }

      if (data.startsWith("admin:") && !isAdmin(telegramId)) {
        await answerCallbackQuery(query.id, "⛔ Нет доступа.");
        return res.status(200).json({ ok: true });
      }

      await answerCallbackQuery(query.id);

      if (data === "home") {
        if (telegramId) await clearSession(telegramId);
        await showHome(chatId, messageId, telegramId);
      } else if (data === "catalog") {
        await showCatalog(chatId, messageId);
      } else if (data === "my_orders") {
        await showMyOrders(chatId, messageId, telegramId);
      } else if (data === "terms:show") {
        await showTerms(chatId, messageId, 0);
      } else if (data.startsWith("terms:accept:")) {
        await acceptTerms(telegramId);
        const productId = Number(data.split(":")[2]) || 0;
        if (productId > 0) {
          await showPublicProduct(chatId, productId, messageId, telegramId);
        } else {
          await showCatalog(chatId, messageId);
        }
      } else if (data === "support:start") {
        await beginSupport(chatId, telegramId, messageId);
      } else if (data.startsWith("product:")) {
        const productId = Number(data.slice("product:".length));
        if (Number.isSafeInteger(productId) && productId > 0) {
          await showPublicProduct(chatId, productId, messageId, telegramId);
        }
      } else if (data.startsWith("buy:")) {
        const productId = Number(data.slice("buy:".length));
        if (isPaymentsTestMode()) {
          await sendMessage(chatId, "⏸️ Реальная оплата отключена на время тестирования. Звёзды не списываются.");
        } else if (!Number.isSafeInteger(productId) || productId < 1) {
          await render(chatId, messageId, "❌ Товар не найден.", {
            inline_keyboard: [[{ text: "⬅️ К каталогу", callback_data: "catalog" }]]
          });
        } else if (!(await hasAcceptedTerms(telegramId))) {
          await showTerms(chatId, messageId, productId);
        } else {
          let order;
          try {
            order = await createStarOrder(productId, telegramId);
            await saveCheckoutMessage(order.orderId, chatId, messageId);
            await telegram("sendInvoice", {
              chat_id: chatId,
              title: order.productName.slice(0, 32) || "VPN-конфиг",
              description: `Цифровой VPN-конфиг · заказ #${order.orderId}`.slice(0, 255),
              payload: order.payload,
              provider_token: "",
              currency: "XTR",
              prices: [{ label: order.productName.slice(0, 32) || "VPN-конфиг", amount: order.stars }],
              start_parameter: "vpnshop"
            });
          } catch (error) {
            if (order?.orderId) {
              try {
                await cancelStarOrder(order.orderId);
                await deleteCheckoutMessage(order.orderId);
              } catch (cancelError) {
                console.error("Could not release failed Stars order:", cancelError);
              }
            }

            const message = error.code === "OUT_OF_STOCK"
              ? "📦 Этот товар только что закончился. Обнови каталог."
              : error.code === "PRODUCT_UNAVAILABLE"
                ? "❌ Товар отключён или не найден."
                : "❌ Не удалось создать счёт. Попробуй ещё раз чуть позже.";
            await sendMessage(chatId, message);
            if (!error.code || !["OUT_OF_STOCK", "PRODUCT_UNAVAILABLE", "BAD_PRICE"].includes(error.code)) {
              console.error("Could not create Telegram Stars invoice:", error);
            }
          }
        }
      } else if (data.startsWith("testbuy:")) {
        const productId = Number(data.slice("testbuy:".length));
        if (!isAdmin(telegramId) || !isPaymentsTestMode()) {
          await sendMessage(chatId, "⛔ Тестовая выдача отключена или у тебя нет доступа.");
        } else if (!Number.isSafeInteger(productId) || productId < 1) {
          await sendMessage(chatId, "❌ Товар не найден.");
        } else {
          await handleTestPurchase(chatId, productId, telegramId, messageId);
        }
      } else if (data === "admin:home") {
        await clearSession(telegramId);
        await showAdminPanel(chatId, messageId);
      } else if (data === "admin:cancel") {
        const session = await getSession(telegramId);
        await clearSession(telegramId);
        if (session) await showAdminPanel(session.chatId, session.messageId);
        else await showAdminPanel(chatId, messageId);
      } else if (data === "admin:new") {
        await beginSession(telegramId, chatId, messageId, "create_name", {},
          "➕ Создание товара\n\nВведи название товара:");
      } else if (data === "admin:products") {
        await clearSession(telegramId);
        await showAdminProducts(chatId, messageId);
      } else if (data === "admin:stock") {
        await clearSession(telegramId);
        await showStock(chatId, messageId);
      } else if (data.startsWith("admin:product:")) {
        const productId = Number(data.split(":")[2]);
        if (Number.isSafeInteger(productId) && productId > 0) {
          await clearSession(telegramId);
          await showAdminProduct(chatId, messageId, productId);
        }
      } else if (data.startsWith("admin:stockprod:")) {
        const productId = Number(data.split(":")[2]);
        if (Number.isSafeInteger(productId) && productId > 0) {
          await clearSession(telegramId);
          await showStockProduct(chatId, messageId, productId);
        }
      } else if (data.startsWith("admin:addstock:")) {
        const productId = Number(data.split(":")[2]);
        if (Number.isSafeInteger(productId) && productId > 0) {
          await beginStockUpload(telegramId, chatId, messageId, productId);
        }
      } else if (data.startsWith("admin:edit:")) {
        const [, , idText, fieldName] = data.split(":");
        const productId = Number(idText);
        const field = EDIT_FIELDS[fieldName];
        if (Number.isSafeInteger(productId) && productId > 0 && field) {
          await beginSession(telegramId, chatId, messageId, "edit_product",
            { productId, field: fieldName },
            `✏️ Изменение поля «${field.label}»\n\n${field.prompt}`);
        }
      } else if (data.startsWith("admin:toggle:")) {
        const productId = Number(data.split(":")[2]);
        if (Number.isSafeInteger(productId) && productId > 0) {
          await db.execute({
            sql: `UPDATE products SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?`,
            args: [productId]
          });
          await showAdminProduct(chatId, messageId, productId);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    return res.status(500).json({ ok: false });
  }
    }
