
import { db, initDatabase } from "../src/db/client.js";

import {
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
      [{ text: "🛒 Купить сервер", callback_data: "catalog" }],
      [{ text: "👤 Моя покупка", callback_data: "my_orders" }]
    ]
  };
}

async function showCatalog(chatId) {
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
    await sendMessage(
      chatId,
      "📦 Пока товаров нет.\nЗагляни чуть позже!",
      mainMenu()
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

  await sendMessage(
    chatId,
    "🛒 Каталог серверов\n\nВыбери предложение:",
    { inline_keyboard: keyboard }
  );
}

async function showProduct(chatId, productId) {
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
    await sendMessage(chatId, "Товар не найден или отключён.");
    return;
  }

  const stock = Number(product.stock);

  await sendMessage(
    chatId,
    `🌐 ${product.name}\n\n` +
      `🌍 Страна: ${product.country}\n` +
      `🔌 Протокол: ${product.protocol}\n` +
      `💰 Цена: ${product.price_rub} ₽\n` +
      `📦 В наличии: ${stock}\n\n` +
      (stock > 0
        ? "Покупка пока находится в разработке."
        : "К сожалению, конфиги закончились."),
    {
      inline_keyboard: [[
        { text: "⬅️ Назад в каталог", callback_data: "catalog" }
      ]]
    }
  );
}

async function showAdminInfo(chatId, telegramId) {
  if (!adminIds.has(String(telegramId))) {
    await sendMessage(
      chatId,
      "⛔ Нет доступа к панели администратора."
    );
    return;
  }

  await sendMessage(
    chatId,
    "🛠 Админ-панель\n\n" +
      "Управление товарами, конфигами и заказами добавим следующим этапом."
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
        await sendMessage(
          chatId,
          "🚀 Добро пожаловать в VPN Config Shop!\n\n" +
            "Выбирай предложение в каталоге.",
          mainMenu()
        );
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

    if (update?.callback_query) {
      const query = update.callback_query;
      const chatId = query.message?.chat?.id;
      const data = query.data || "";

      await answerCallbackQuery(query.id);

      if (data === "catalog" && chatId) {
        await showCatalog(chatId);
      } else if (data === "home" && chatId) {
        await sendMessage(chatId, "🏠 Главное меню", mainMenu());
      } else if (data === "my_orders" && chatId) {
        await sendMessage(
          chatId,
          "🧾 История покупок появится после подключения платежей."
        );
      } else if (data.startsWith("product:") && chatId) {
        const productId = Number(data.slice("product:".length));

        if (Number.isSafeInteger(productId) && productId > 0) {
          await showProduct(chatId, productId);
        } else {
          await sendMessage(chatId, "Некорректный товар.");
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed:", error);

    // Telegram должен получить ошибку, чтобы обновление не считалось
    // успешно обработанным. Не логируем токены или содержимое конфига.
    return res.status(500).json({ ok: false });
  }
}
