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

export function editMessageText(chatId, messageId, text, replyMarkup) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
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

export async function downloadTelegramFile(fileId, maxBytes = 1_000_000) {
  const file = await telegram("getFile", {
    file_id: fileId
  });

  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (
    Number(file.file_size || 0) > maxBytes
  ) {
    throw new Error("Файл слишком большой. Максимум — 1 МБ.");
  }

  const url =
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Не удалось скачать файл из Telegram");
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > maxBytes) {
    throw new Error("Файл слишком большой. Максимум — 1 МБ.");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("Файл должен содержать корректный UTF-8 текст.");
  }
}
