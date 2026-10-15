
import { db, initDatabase } from "../src/db/client.js";

import {
  telegram,
  sendMessage,
  answerCallbackQuery,
  downloadTelegramFile
} from "../src/bot/telegram.js";

const adminIds = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const MAX_CONFIGS_PER_UPLOAD = 500;
const MAX_CONFIG_LENGTH = 4096;

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
    column: "price_rub",
    label: "цену",
    prompt: "Введи новую цену в целых рублях:"
  }
};

function isAdmin(telegramId) {
  return adminIds.has(String(telegramId));
}

function mainMenu(telegramId) {
  const rows = [
    [{ text: "🛒 Купить конфиг", callback_data: "catalog" }],
    [{ text: "👤 Мои покупки", callback_data: "my_orders" }]
  ];

  if (isAdmin(telegramId)) {
    rows.push([
      { text: "🛠 Админ-панель", callback_data: "admin:home" }
    ]);
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

async function editMessage(chatId, messageId, text, replyMarkup) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  } catch (error) {
    if (String(error).includes("message is not modified")) {
      return null;
    }

    throw error;
  }
}

async function render(chatId, messageId, text, keyboard) {
  if (messageId) {
    return editMessage(chatId, messageId, text, keyboard);
  }

  return sendMessage(chatId, text, keyboard);
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
    sql: `
      SELECT action, data_json, chat_id, message_id
      FROM admin_sessions
      WHERE telegram_id = ?
    `,
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
    "🚀 VPN Config Shop\n\nВыбирай нужный раздел:",
    mainMenu(telegramId)
  );
}

async function showAdminPanel(chatId, messageId) {
  await render(
    chatId,
    messageId,
    "🛠 Админ-панель\n\n" +
      "Управляй товарами и складом конфигов.\n\n" +
      "Оплата пока не подключена.",
    adminKeyboard()
  );
}

async function showCatalog(chatId, messageId = null) {
  const result = await db.execute({
    sql: `
      SELECT
        p.id,
        p.name,
        p.price_rub,
        COUNT(c.id) AS stock
      FROM products p
      LEFT JOIN configs c
        ON c.product_id = p.id
        AND c.status = 'available'
      WHERE p.active = 1
      GROUP BY p.id
      ORDER BY p.id DESC
    `
  });

  if (!result.rows.length) {
    await render(
      chatId,
      messageId,
      "🛒 Каталог\n\n📦 Пока товаров нет.",
      {
        inline_keyboard: [
          [{ text: "⬅️ В меню", callback_data: "home" }]
        ]
      }
    );

    return;
  }

  const keyboard = result.rows.map((p) => {
    const stock = Number(p.stock);

    return [{
      text: stock > 0
        ? `${p.name} — ${p.price_rub} ₽ · ${stock} шт.`
        : `${p.name} — нет в наличии`,
      callback_data: `product:${p.id}`
    }];
  });

  keyboard.push([
    { text: "⬅️ В меню", callback_data: "home" }
  ]);

  await render(
    chatId,
    messageId,
    "🛒 Каталог конфигов\n\nВыбери предложение:",
    { inline_keyboard: keyboard }
  );
}

async function showPublicProduct(chatId, productId, messageId) {
  const result = await db.execute({
    sql: `
      SELECT p.*,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS stock
      FROM products p
      WHERE p.id = ? AND p.active = 1
    `,
    args: [productId]
  });

  const p = result.rows[0];

  if (!p) {
    await render(
      chatId,
      messageId,
      "❌ Товар не найден или отключён.",
      {
        inline_keyboard: [
          [{ text: "⬅️ В каталог", callback_data: "catalog" }]
        ]
      }
    );

    return;
  }

  await render(
    chatId,
    messageId,
    `🌐 ${p.name}\n\n` +
      `🌍 Страна: ${p.country}\n` +
      `🔌 Протокол: ${p.protocol}\n` +
      `💰 Цена: ${p.price_rub} ₽\n` +
      `📦 В наличии: ${Number(p.stock)}\n\n` +
      "Покупка и оплата будут доступны после подключения платежей.",
    {
      inline_keyboard: [
        [{ text: "⬅️ Назад в каталог", callback_data: "catalog" }],
        [{ text: "🏠 В меню", callback_data: "home" }]
      ]
    }
  );
}

async function showAdminProducts(chatId, messageId) {
  const result = await db.execute({
    sql: `
      SELECT
        p.id, p.name, p.price_rub, p.active,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS stock
      FROM products p
      ORDER BY p.id DESC
    `
  });

  if (!result.rows.length) {
    await render(
      chatId,
      messageId,
      "📝 Товаров пока нет. Создай первый товар!",
      {
        inline_keyboard: [
          [{ text: "➕ Создать товар", callback_data: "admin:new" }],
          [{ text: "⬅️ В админку", callback_data: "admin:home" }]
        ]
      }
    );

    return;
  }

  const keyboard = result.rows.map((p) => [{
    text:
      `${p.active ? "🟢" : "⚪"} ${p.name} · ${p.price_rub} ₽ · ${Number(p.stock)} шт.`,
    callback_data: `admin:product:${p.id}`
  }]);

  keyboard.push([
    { text: "➕ Создать товар", callback_data: "admin:new" }
  ]);
  keyboard.push([
    { text: "⬅️ В админку", callback_data: "admin:home" }
  ]);

  await render(
    chatId,
    messageId,
    "📝 Управление товарами\n\n" +
      "🟢 — активен\n⚪ — отключён\n\nВыбери товар:",
    { inline_keyboard: keyboard }
  );
}

async function getAdminProduct(productId) {
  const result = await db.execute({
    sql: `
      SELECT p.*,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS available_stock,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'sold') AS sold_stock,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'reserved') AS reserved_stock
      FROM products p
      WHERE p.id = ?
    `,
    args: [productId]
  });

  return result.rows[0] || null;
}

async function showAdminProduct(chatId, messageId, productId) {
  const p = await getAdminProduct(productId);

  if (!p) {
    await render(
      chatId,
      messageId,
      "❌ Товар не найден.",
      {
        inline_keyboard: [
          [{ text: "⬅️ К товарам", callback_data: "admin:products" }]
        ]
      }
    );

    return;
  }

  await render(
    chatId,
    messageId,
    `📝 Товар #${p.id}\n\n` +
      `Название: ${p.name}\n` +
      `Страна: ${p.country}\n` +
      `Протокол: ${p.protocol}\n` +
      `Цена: ${p.price_rub} ₽\n` +
      `Статус: ${p.active ? "🟢 активен" : "⚪ отключён"}\n\n` +
      `📦 В наличии: ${Number(p.available_stock)}\n` +
      `🧾 Продано: ${Number(p.sold_stock)}\n` +
      `⏳ Зарезервировано: ${Number(p.reserved_stock)}`,
    {
      inline_keyboard: [
        [
          { text: "✏️ Название", callback_data: `admin:edit:${p.id}:name` },
          { text: "🌍 Страна", callback_data: `admin:edit:${p.id}:country` }
        ],
        [
          { text: "🔌 Протокол", callback_data: `admin:edit:${p.id}:protocol` },
          { text: "💰 Цена", callback_data: `admin:edit:${p.id}:price` }
        ],
        [{ text: "📥 Добавить конфиги", callback_data: `admin:addstock:${p.id}` }],
        [{ text: "📦 Управление складом", callback_data: `admin:stockprod:${p.id}` }],
        [{
          text: p.active ? "⏸ Отключить товар" : "▶️ Включить товар",
          callback_data: `admin:toggle:${p.id}`
        }],
        [{ text: "⬅️ К товарам", callback_data: "admin:products" }],
        [{ text: "🏠 В админку", callback_data: "admin:home" }]
      ]
    }
  );
}

async function showStock(chatId, messageId) {
  const result = await db.execute({
    sql: `
      SELECT
        p.id, p.name, p.active,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'available') AS available_stock,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'sold') AS sold_stock,
        (SELECT COUNT(*) FROM configs c
          WHERE c.product_id = p.id AND c.status = 'reserved') AS reserved_stock
      FROM products p
      ORDER BY p.id DESC
    `
  });

  if (!result.rows.length) {
    await render(
      chatId,
      messageId,
      "📦 Склад пуст — сначала создай товар.",
      {
        inline_keyboard: [
          [{ text: "➕ Создать товар", callback_data: "admin:new" }],
          [{ text: "⬅️ В админку", callback_data: "admin:home" }]
        ]
      }
    );

    return;
  }

  const keyboard = result.rows.map((p) => [{
    text: `${p.name} · ${Number(p.available_stock)} доступно`,
    callback_data: `admin:stockprod:${p.id}`
  }]);

  keyboard.push([
    { text: "⬅️ В админку", callback_data: "admin:home" }
  ]);

  const summary = result.rows.map((p) =>
    `${p.name}\n` +
    `  Доступно: ${Number(p.available_stock)} · ` +
    `Продано: ${Number(p.sold_stock)} · ` +
    `Резерв: ${Number(p.reserved_stock)}`
  ).join("\n\n");

  await render(
    chatId,
    messageId,
    `📦 Склад конфигов\n\n${summary}\n\nВыбери товар для подробностей:`,
    { inline_keyboard: keyboard }
  );
}

async function showStockProduct(chatId, messageId, productId) {
  const p = await getAdminProduct(productId);

  if (!p) {
    await showStock(chatId, messageId);
    return;
  }

  await render(
    chatId,
    messageId,
    `📦 Склад: ${p.name}\n\n` +
      `Доступно: ${Number(p.available_stock)}\n` +
      `Продано: ${Number(p.sold_stock)}\n` +
      `Зарезервировано: ${Number(p.reserved_stock)}\n\n` +
      "Добавление конфигов поддерживает текстовые URI и файлы .txt.",
    {
      inline_keyboard: [
        [{ text: "📥 Добавить конфиги", callback_data: `admin:addstock:${p.id}` }],
        [{ text: "📝 Карточка товара", callback_data: `admin:product:${p.id}` }],
        [{ text: "⬅️ К складу", callback_data: "admin:stock" }],
        [{ text: "🏠 В админку", callback_data: "admin:home" }]
      ]
    }
  );
}

async function beginSession(
  telegramId,
  chatId,
  messageId,
  action,
  data,
  prompt
) {
  await saveSession(telegramId, action, data, chatId, messageId);
  await editMessage(chatId, messageId, prompt, cancelKeyboard());
}

async function beginStockUpload(telegramId, chatId, messageId, productId) {
  const p = await getAdminProduct(productId);

  if (!p) {
    await render(
      chatId,
      messageId,
      "❌ Товар не найден.",
      {
        inline_keyboard: [
          [{ text: "⬅️ К складу", callback_data: "admin:stock" }]
        ]
      }
    );

    return;
  }

  await beginSession(
    telegramId,
    chatId,
    messageId,
    "add_stock",
    { productId },
    `📥 Загрузка конфигов: ${p.name}\n\n` +
      "Отправь один или несколько URI текстом, каждый с новой строки, " +
      "либо отправь файл .txt.\n\n" +
      "Поддерживаются VLESS, VMess, Trojan, Shadowsocks, SOCKS и Hysteria.\n" +
      "Пустые строки и строки-комментарии, начинающиеся с #, игнорируются.\n\n" +
      "Максимум за одну загрузку: 500 конфигов."
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
    return {
      inserted: 0,
      duplicates: 0,
      invalid: 0,
      message: "Файл или сообщение не содержит конфигов."
    };
  }

  if (lines.length > MAX_CONFIGS_PER_UPLOAD) {
    throw new Error(
      `Слишком много строк: максимум ${MAX_CONFIGS_PER_UPLOAD} конфигов за загрузку.`
    );
  }

  const productResult = await db.execute({
    sql: "SELECT id FROM products WHERE id = ?",
    args: [productId]
  });

  if (!productResult.rows.length) {
    throw new Error("Товар не найден.");
  }

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
      sql: `
        INSERT INTO configs (product_id, config_text, status)
        VALUES (?, ?, 'available')
      `,
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
      const doc = message.document;
      const filename = (doc.file_name || "").toLowerCase();

      if (
        !filename.endsWith(".txt") &&
        doc.mime_type !== "text/plain"
      ) {
        await editMessage(
          chatId,
          messageId,
          "❌ Отправь текстовый файл .txt или вставь URI сообщением.",
          cancelKeyboard()
        );
        return;
      }

      try {
        content = await downloadTelegramFile(doc.file_id);
      } catch (error) {
        await editMessage(
          chatId,
          messageId,
          `❌ Не удалось прочитать файл: ${error.message}\n\nПопробуй ещё раз.`,
          cancelKeyboard()
        );
        return;
      }
    } else if (text) {
      content = text;
    } else {
      await editMessage(
        chatId,
        messageId,
        "Отправь URI текстом или файл .txt.",
        cancelKeyboard()
      );
      return;
    }

    try {
      const result = await importConfigs(data.productId, content);

      await clearSession(telegramId);

      const summary =
        `✅ Загрузка завершена\n\n` +
        `Добавлено: ${result.inserted}\n` +
        `Дубликатов: ${result.duplicates}\n` +
        `Некорректных строк: ${result.invalid}` +
        (result.message ? `\n\n${result.message}` : "");

      await render(
        chatId,
        messageId,
        summary,
        {
          inline_keyboard: [
            [{
              text: "📥 Добавить ещё",
              callback_data: `admin:addstock:${data.productId}`
            }],
            [{
              text: "📦 К складу товара",
              callback_data: `admin:stockprod:${data.productId}`
            }],
            [{
              text: "🛠 В админку",
              callback_data: "admin:home"
            }]
          ]
        }
      );
    } catch (error) {
      await editMessage(
        chatId,
        messageId,
        `❌ Ошибка загрузки: ${error.message}\n\nПопробуй ещё раз.`,
        cancelKeyboard()
      );
    }

    return;
  }

  if (message.document) {
    await editMessage(
      chatId,
      messageId,
      "Для этого шага нужен текст. Отправь значение сообщением.",
      cancelKeyboard()
    );
    return;
  }

  if (!text) {
    await editMessage(
      chatId,
      messageId,
      "Отправь значение текстом.",
      cancelKeyboard()
    );
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

    await saveSession(
      telegramId,
      "create_protocol",
      { ...data, country: text },
      chatId,
      messageId
    );

    await editMessage(
      chatId,
      messageId,
      "🔌 Введи название протокола (например, VLESS Reality):",
      cancelKeyboard()
    );
    return;
  }

  if (session.action === "create_protocol") {
    if (text.length > 40) {
      await editMessage(chatId, messageId, "Название протокола слишком длинное. Максимум 40 символов.", cancelKeyboard());
      return;
    }

    await saveSession(
      telegramId,
      "create_price",
      { ...data, protocol: text },
      chatId,
      messageId
    );

    await editMessage(
      chatId,
      messageId,
      "💰 Введи цену в целых рублях, например 19:",
      cancelKeyboard()
    );
    return;
  }

  if (session.action === "create_price") {
    const price = Number(text);

    if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000) {
      await editMessage(
        chatId,
        messageId,
        "❌ Цена должна быть целым числом от 1 до 1 000 000 ₽. Попробуй ещё раз:",
        cancelKeyboard()
      );
      return;
    }

    const result = await db.execute({
      sql: `
        INSERT INTO products (name, country, protocol, price_rub, active)
        VALUES (?, ?, ?, ?, 1)
      `,
      args: [data.name, data.country, data.protocol, price]
    });

    const productId = Number(result.lastInsertRowid);

    await clearSession(telegramId);

    await render(
      chatId,
      messageId,
      `✅ Товар создан!\n\n` +
        `Название: ${data.name}\n` +
        `Страна: ${data.country}\n` +
        `Протокол: ${data.protocol}\n` +
        `Цена: ${price} ₽\n\n` +
        "Теперь можно загрузить конфиги на склад.",
      {
        inline_keyboard: [
          [{
            text: "📥 Добавить конфиги",
            callback_data: `admin:addstock:${productId}`
          }],
          [{
            text: "📝 Открыть товар",
            callback_data: `admin:product:${productId}`
          }],
          [{
            text: "🛠 В админку",
            callback_data: "admin:home"
          }]
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

      if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
        await editMessage(
          chatId,
          messageId,
          "❌ Цена должна быть целым числом от 1 до 1 000 000 ₽. Попробуй ещё раз:",
          cancelKeyboard()
        );
        return;
      }
    } else if (text.length > (data.field === "name" ? 80 : 60)) {
      await editMessage(
        chatId,
        messageId,
        "❌ Значение слишком длинное. Попробуй ещё раз:",
        cancelKeyboard()
      );
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const secret = process.env.WEBHOOK_SECRET;
  const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];

  if (
    !secret ||
    typeof receivedSecret !== "string" ||
    receivedSecret !== secret
  ) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await initDatabase();

    const update = req.body;

    if (update?.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const telegramId = message.from?.id;
      const text = (message.text || "").trim();

      if (telegramId) {
        await db.execute({
          sql: `
            INSERT INTO users (telegram_id)
            VALUES (?)
            ON CONFLICT(telegram_id) DO NOTHING
          `,
          args: [String(telegramId)]
        });
      }

      if (text === "/cancel") {
        if (telegramId && isAdmin(telegramId)) {
          const session = await getSession(telegramId);

          await clearSession(telegramId);

          if (session) {
            await showAdminPanel(session.chatId, session.messageId);
          } else {
            await showAdminPanel(chatId, null);
          }
        } else {
          await sendMessage(chatId, "Нет активной операции.", mainMenu(telegramId));
        }
      } else if (text === "/start") {
        if (telegramId && isAdmin(telegramId)) {
          await clearSession(telegramId);
        }

        await showHome(chatId, null, telegramId);
      } else if (text === "/catalog") {
        if (telegramId && isAdmin(telegramId)) {
          await clearSession(telegramId);
        }

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

        if (session) {
          await handleAdminInput(message, session);
        } else {
          await sendMessage(
            chatId,
            "Используй меню ниже 👇",
            mainMenu(telegramId)
          );
        }
      } else {
        await sendMessage(
          chatId,
          "Используй меню ниже 👇",
          mainMenu(telegramId)
        );
      }
    }

    if (update?.callback_query) {
      const query = update.callback_query;
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      const telegramId = query.from?.id;
      const data = query.data || "";

      if (data.startsWith("admin:") && !isAdmin(telegramId)) {
        await answerCallbackQuery(query.id, "⛔ Нет доступа.");
        return res.status(200).json({ ok: true });
      }

      await answerCallbackQuery(query.id);

      if (!chatId || !messageId) {
        return res.status(200).json({ ok: true });
      }

      if (data === "home") {
        if (isAdmin(telegramId)) {
          await clearSession(telegramId);
        }

        await showHome(chatId, messageId, telegramId);
      } else if (data === "catalog") {
        await showCatalog(chatId, messageId);
      } else if (data === "my_orders") {
        await render(
          chatId,
          messageId,
          "👤 Мои покупки\n\nИстория заказов появится после подключения оплаты.",
          {
            inline_keyboard: [
              [{ text: "🛒 Каталог", callback_data: "catalog" }],
              [{ text: "⬅️ В меню", callback_data: "home" }]
            ]
          }
        );
      } else if (data.startsWith("product:")) {
        const productId = Number(data.slice("product:".length));

        if (Number.isSafeInteger(productId) && productId > 0) {
          await showPublicProduct(chatId, productId, messageId);
        }
      } else if (data === "admin:home") {
        await clearSession(telegramId);
        await showAdminPanel(chatId, messageId);
      } else if (data === "admin:cancel") {
        const session = await getSession(telegramId);
        await clearSession(telegramId);

        if (session) {
          await showAdminPanel(session.chatId, session.messageId);
        } else {
          await showAdminPanel(chatId, messageId);
        }
      } else if (data === "admin:new") {
        await beginSession(
          telegramId,
          chatId,
          messageId,
          "create_name",
          {},
          "➕ Создание товара\n\nВведи название товара:"
        );
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

        if (
          Number.isSafeInteger(productId) &&
          productId > 0 &&
          field
        ) {
          await beginSession(
            telegramId,
            chatId,
            messageId,
            "edit_product",
            { productId, field: fieldName },
            `✏️ Изменение поля «${field.label}»\n\n${field.prompt}`
          );
        }
      } else if (data.startsWith("admin:toggle:")) {
        const productId = Number(data.split(":")[2]);

        if (Number.isSafeInteger(productId) && productId > 0) {
          await db.execute({
            sql: `
              UPDATE products
              SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END
              WHERE id = ?
            `,
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
