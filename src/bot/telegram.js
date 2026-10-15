const BOT_TOKEN = process.env.BOT_TOKEN;

export async function telegram(method, payload = {}) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(result)}`);
  }

  return result.result;
}

export function sendMessage(chatId, text, replyMarkup) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

export function answerCallbackQuery(callbackQueryId, text) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}
