import { db, initDatabase } from "../src/db/client.js";

import {
  telegram,
  sendMessage,
  answerCallbackQuery
} from "../src/bot/telegram.js";

const adminIds = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Купить конфиг", callback_data: "catalog" }],
      [{ text: "👤 Мои покупки", callback_data: "my_orders" }]
    ]
  };
}

/**
 * Редактирует текущее сообщение.
 * Если Telegram сообщает, что текст не изменился,
 * считаем это нормальной ситуацией.
 */
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

/**
 * Показывает экран:
 * - редактирует сообщение, если передан messageId;
 * - отправляет новое, если это команда из чата.
 */
async function render(chatId, messageId, text, keyboard) {
  if (messageId) {
    return editMessage(chatId, messageId, text, keyboard);
  }

  return sendMessage(chatId, text, keyboard);
}

async function showHome(chatId, messageId = null) {
  await render(
    chatId,
    messageId,
    "🚀 VPN Config Shop\n\nВыбирай, что тебя интересует:",
    mainMenu()
  );
}

async function showCatalog(chatId, messageId = null) {
  const result = await db.execute({
    sql: `
      SELECT
        p.id,
        p.name,
        p.country,
        p.protocol,
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

  if (result.rows.length === 0) {
    await render(
      chatId,
      messageId,
      "🛒 Каталог\n\n📦 Пока товаров нет. Загляни позже!",
      {
        inline_keyboard: [
          [{ text: "⬅️ В меню", callback_data: "home" }]
        ]
      }
    );

    return;
  }

  const keyboard = result.rows.map((product) => {
    const stock = Number(product.stock);

    return [{
      text: stock > 0
        ? `${product.name} — ${product.price_rub} ₽ · ${stock} шт.`
        : `${product.name} — нет в наличии`,
      callback_data: `product:${product.id}`
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

async function showProduct(chatId, productId, messageId = null) {
  const result = await db.execute({
    sql: `
      SELECT
        p.id,
        p.name,
        p.country,
        p.protocol,
        p.price_rub,
        COUNT(c.id) AS stock
      FROM products p
      LEFT JOIN configs c
        ON c.product_id = p.id
        AND c.status = 'available'
      WHERE p.id = ? AND p.active = 1
      GROUP BY p.id
    `,
    args: [productId]
  });

  const product = result.rows[0];

  if (!product) {
    await render(
      chatId,
      messageId,
      "❌ Товар не найден или больше не продаётся.",
      {
        inline_keyboard: [
          [{ text: "⬅️ В каталог", callback_data: "catalog" }]
        ]
      }
    );

    return;
  }

  const stock = Number(product.stock);

  const description =
    `🌐 ${product.name}\n\n` +
    `🌍 Страна: ${product.country}\n` +
    `🔌 Протокол: ${product.protocol}\n` +
    `💰 Цена: ${product.price_rub} ₽\n` +
    `📦 В наличии: ${stock}\n\n` +
    (
      stock > 0
        ? "🛠 Покупка пока находится в разработке."
        : "😔 Конфиги закончились."
    );

  await render(
    chatId,
    messageId,
    description,
    {
      inline_keyboard: [
        [{ text: "⬅️ Назад в каталог", callback_data: "catalog" }],
        [{ text: "🏠 В меню", callback_data: "home" }]
      ]
    }
  );
}

async function showMyOrders(chatId, messageId = null) {
  await render(
    chatId,
    messageId,
    "👤 Мои покупки\n\nИстория заказов появится после подключения оформления и оплаты.",
    {
      inline_keyboard: [
        [{ text: "🛒 Каталог", callback_data: "catalog" }],
        [{ text: "⬅️ В меню", callback_data: "home" }]
      ]
    }
  );
}

async function showAdminInfo(chatId, telegramId, messageId = null) {
  if (!adminIds.has(String(telegramId))) {
    await render(
      chatId,
      messageId,
      "⛔ Нет доступа к панели администратора.",
      {
        inline_keyboard: [
          [{ text: "⬅️ В меню", callback_data: "home" }]
        ]
      }
    );

    return;
  }

  await render(
    chatId,
    messageId,
    "🛠 Админ-панель\n\nУправление товарами, конфигами и заказами добавим следующим этапом.",
    {
      inline_keyboard: [
        [{ text: "⬅️ В меню", callback_data: "home" }]
      ]
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const secret = process.env.WEBHOOK_SECRET;
  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"];

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

    // Обработка обычных сообщений и команд
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

      if (text === "/start") {
        await showHome(chatId);
      } else if (text === "/catalog") {
        await showCatalog(chatId);
      } else if (text === "/admin") {
        await showAdminInfo(chatId, telegramId);
      } else {
        await sendMessage(
          chatId,
          "Используй меню ниже 👇",
          mainMenu()
        );
      }
    }

    // Обработка нажатий кнопок — без новых сообщений
    if (update?.callback_query) {
      const query = update.callback_query;
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      const telegramId = query.from?.id;
      const data = query.data || "";

      await answerCallbackQuery(query.id);

      if (chatId && messageId) {
        if (data === "catalog") {
          await showCatalog(chatId, messageId);
        } else if (data === "home") {
          await showHome(chatId, messageId);
        } else if (data === "my_orders") {
          await showMyOrders(chatId, messageId);
        } else if (data === "admin") {
          await showAdminInfo(chatId, telegramId, messageId);
        } else if (data.startsWith("product:")) {
          const productId = Number(
            data.slice("product:".length)
          );

          if (
            Number.isSafeInteger(productId) &&
            productId > 0
          ) {
            await showProduct(chatId, productId, messageId);
          } else {
            await editMessage(
              chatId,
              messageId,
              "❌ Некорректный товар.",
              {
                inline_keyboard: [
                  [{ text: "⬅️ В каталог", callback_data: "catalog" }]
                ]
              }
            );
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    return res.status(500).json({ ok: false });
  }
}
