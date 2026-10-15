import { db } from "../db/client.js";

const ORDER_PAYLOAD_PREFIX = "vpnshop_order_";
const ORDER_RESERVATION_MINUTES = 30;

function parseOrderId(payload) {
  if (typeof payload !== "string") return null;
  const match = payload.match(/^vpnshop_order_(\d+)$/);
  if (!match) return null;

  const orderId = Number(match[1]);
  return Number.isSafeInteger(orderId) && orderId > 0 ? orderId : null;
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function expireOldOrders(tx) {
  const oldOrderFilter = `
    SELECT id FROM orders
    WHERE status = 'pending'
      AND created_at <= datetime('now', '-${ORDER_RESERVATION_MINUTES} minutes')
  `;

  await tx.execute({
    sql: `UPDATE configs
      SET status = 'available', order_id = NULL
      WHERE status = 'reserved' AND order_id IN (${oldOrderFilter})`
  });

  await tx.execute({
    sql: `UPDATE orders
      SET status = 'cancelled', config_id = NULL
      WHERE status = 'pending'
        AND created_at <= datetime('now', '-${ORDER_RESERVATION_MINUTES} minutes')`
  });

  await tx.execute({
    sql: `UPDATE payments
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending'
        AND order_id IN (SELECT id FROM orders WHERE status = 'cancelled')`
  });
}

export async function createStarOrder(productId, telegramId, checkout = {}) {
  const tx = await db.transaction("write");

  try {
    await expireOldOrders(tx);

    const productResult = await tx.execute({
      sql: `SELECT id, name, price_stars, active
        FROM products WHERE id = ?`,
      args: [productId]
    });

    const product = productResult.rows[0];

    if (!product || Number(product.active) !== 1) {
      throw makeError("Товар не найден или отключён.", "PRODUCT_UNAVAILABLE");
    }

    const stars = Number(product.price_stars);

    if (!Number.isSafeInteger(stars) || stars < 1) {
      throw makeError("У товара указана некорректная цена в Stars.", "BAD_PRICE");
    }

    const orderResult = await tx.execute({
      sql: `INSERT INTO orders
          (telegram_id, product_id, amount_rub, amount_stars, status,
           checkout_chat_id, checkout_message_id)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      args: [
        String(telegramId),
        productId,
        stars,
        stars,
        checkout.chatId == null ? null : String(checkout.chatId),
        checkout.messageId == null ? null : Number(checkout.messageId)
      ]
    });

    const orderId = Number(orderResult.lastInsertRowid);

    const reservationResult = await tx.execute({
      sql: `UPDATE configs
        SET status = 'reserved', order_id = ?
        WHERE id = (
          SELECT id FROM configs
          WHERE product_id = ? AND status = 'available'
          ORDER BY id ASC LIMIT 1
        )
        AND status = 'available'
        RETURNING id`,
      args: [orderId, productId]
    });

    const reservation = reservationResult.rows[0];

    if (!reservation) {
      throw makeError("Конфиги этого товара закончились.", "OUT_OF_STOCK");
    }

    await tx.execute({
      sql: "UPDATE orders SET config_id = ? WHERE id = ?",
      args: [Number(reservation.id), orderId]
    });

    await tx.execute({
      sql: `INSERT INTO payments (order_id, idempotence_key, status)
        VALUES (?, ?, 'pending')`,
      args: [orderId, `telegram-stars-order-${orderId}`]
    });

    await tx.commit();

    return {
      orderId,
      payload: `${ORDER_PAYLOAD_PREFIX}${orderId}`,
      productName: String(product.name),
      stars
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function cancelStarOrder(orderId) {
  const tx = await db.transaction("write");

  try {
    await tx.execute({
      sql: `UPDATE configs
        SET status = 'available', order_id = NULL
        WHERE order_id = ? AND status = 'reserved'`,
      args: [orderId]
    });

    await tx.execute({
      sql: `UPDATE orders
        SET status = 'cancelled', config_id = NULL
        WHERE id = ? AND status = 'pending'`,
      args: [orderId]
    });

    await tx.execute({
      sql: `UPDATE payments SET status = 'failed', updated_at = datetime('now')
        WHERE order_id = ? AND status = 'pending'`,
      args: [orderId]
    });

    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function validateStarPreCheckout(query) {
  const orderId = parseOrderId(query.invoice_payload);

  if (!orderId) {
    return {
      ok: false,
      errorMessage: "Счёт не распознан. Открой каталог и создай новый."
    };
  }

  if (query.currency !== "XTR") {
    return { ok: false, errorMessage: "Неверная валюта счёта." };
  }

  const result = await db.execute({
    sql: `SELECT
        o.id, o.telegram_id, o.amount_stars, o.status AS order_status,
        o.created_at, p.status AS payment_status,
        c.status AS config_status, c.order_id AS config_order_id,
        pr.active
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      JOIN products pr ON pr.id = o.product_id
      LEFT JOIN configs c ON c.id = o.config_id
      WHERE o.id = ?`,
    args: [orderId]
  });

  const order = result.rows[0];

  if (!order || String(order.telegram_id) !== String(query.from.id)) {
    return {
      ok: false,
      errorMessage: "Этот счёт принадлежит другому покупателю."
    };
  }

  if (order.order_status !== "pending" || order.payment_status !== "pending") {
    return {
      ok: false,
      errorMessage: "Счёт уже использован или истёк. Создай новый."
    };
  }

  if (Number(order.amount_stars) !== Number(query.total_amount)) {
    return {
      ok: false,
      errorMessage: "Сумма счёта не совпадает. Создай новый счёт."
    };
  }

  if (
    Number(order.active) !== 1 ||
    order.config_status !== "reserved" ||
    Number(order.config_order_id) !== orderId
  ) {
    return {
      ok: false,
      errorMessage: "Этот конфиг больше не зарезервирован. Попробуй купить заново."
    };
  }

  const ageResult = await db.execute({
    sql: `SELECT CASE WHEN ? > datetime('now', '-${ORDER_RESERVATION_MINUTES} minutes')
      THEN 1 ELSE 0 END AS valid`,
    args: [order.created_at]
  });

  if (Number(ageResult.rows[0]?.valid) !== 1) {
    return {
      ok: false,
      errorMessage: "Счёт истёк. Открой товар и создай новый счёт."
    };
  }

  return { ok: true };
}

export async function completeTestStarOrder(orderId, telegramId) {
  const tx = await db.transaction("write");

  try {
    const result = await tx.execute({
      sql: `SELECT
          o.id, o.telegram_id, o.status AS order_status, o.config_id,
          o.checkout_chat_id, o.checkout_message_id,
          p.status AS payment_status,
          c.config_text, c.status AS config_status,
          c.order_id AS config_order_id
        FROM orders o
        JOIN payments p ON p.order_id = o.id
        LEFT JOIN configs c ON c.id = o.config_id
        WHERE o.id = ?`,
      args: [orderId]
    });

    const order = result.rows[0];

    if (!order || String(order.telegram_id) !== String(telegramId)) {
      throw new Error("Тестовый заказ не найден или принадлежит другому пользователю.");
    }

    if (
      order.order_status === "delivered" &&
      order.payment_status === "test" &&
      order.config_text
    ) {
      await tx.commit();

      return {
        orderId: Number(orderId),
        configText: String(order.config_text),
        checkoutChatId: order.checkout_chat_id,
        checkoutMessageId: order.checkout_message_id == null
          ? null
          : Number(order.checkout_message_id),
        duplicate: true,
        fulfilled: true
      };
    }

    if (order.order_status !== "pending" || order.payment_status !== "pending") {
      throw new Error("Тестовый заказ уже использован или отменён.");
    }

    if (
      !order.config_id ||
      order.config_status !== "reserved" ||
      Number(order.config_order_id) !== Number(orderId) ||
      !order.config_text
    ) {
      throw new Error("Резерв конфига не найден. Попробуй ещё раз.");
    }

    const configId = Number(order.config_id);
    const configText = String(order.config_text);

    const releaseResult = await tx.execute({
      sql: `UPDATE configs SET status = 'available', order_id = NULL
        WHERE id = ? AND status = 'reserved' AND order_id = ?`,
      args: [configId, orderId]
    });

    if (Number(releaseResult.rowsAffected) !== 1) {
      throw new Error("Не удалось вернуть конфиг на склад после теста.");
    }

    await tx.execute({
      sql: `UPDATE orders
        SET status = 'delivered', config_id = NULL,
            delivered_at = COALESCE(delivered_at, datetime('now'))
        WHERE id = ?`,
      args: [orderId]
    });

    await tx.execute({
      sql: `UPDATE payments SET status = 'test', updated_at = datetime('now')
        WHERE order_id = ? AND status = 'pending'`,
      args: [orderId]
    });

    await tx.commit();

    return {
      orderId: Number(orderId),
      configText,
      checkoutChatId: order.checkout_chat_id,
      checkoutMessageId: order.checkout_message_id == null
        ? null
        : Number(order.checkout_message_id),
      duplicate: false,
      fulfilled: true
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function processSuccessfulStarPayment(message) {
  const payment = message?.successful_payment;
  const telegramId = message?.from?.id;
  const orderId = parseOrderId(payment?.invoice_payload);
  const chargeId = payment?.telegram_payment_charge_id;

  if (!payment || !telegramId || !orderId || !chargeId) {
    throw new Error("Получен неполный successful_payment от Telegram.");
  }

  if (payment.currency !== "XTR") {
    throw new Error(`Заказ #${orderId}: unexpected payment currency.`);
  }

  const tx = await db.transaction("write");

  try {
    const result = await tx.execute({
      sql: `SELECT
          o.id, o.telegram_id, o.product_id, o.amount_stars,
          o.status AS order_status, o.config_id,
          o.checkout_chat_id, o.checkout_message_id,
          p.status AS payment_status, p.provider_payment_id,
          c.config_text, c.status AS config_status, c.order_id AS config_order_id
        FROM orders o
        JOIN payments p ON p.order_id = o.id
        LEFT JOIN configs c ON c.id = o.config_id
        WHERE o.id = ?`,
      args: [orderId]
    });

    const order = result.rows[0];

    if (!order || String(order.telegram_id) !== String(telegramId)) {
      throw new Error(`Stars payment refers to an unknown order #${orderId}.`);
    }

    if (Number(order.amount_stars) !== Number(payment.total_amount)) {
      throw new Error(`Stars payment amount mismatch for order #${orderId}.`);
    }

    if (
      order.order_status === "delivered" &&
      order.payment_status === "paid" &&
      order.provider_payment_id === chargeId &&
      order.config_text
    ) {
      await tx.commit();

      return {
        orderId,
        configText: String(order.config_text),
        checkoutChatId: order.checkout_chat_id,
        checkoutMessageId: order.checkout_message_id == null
          ? null
          : Number(order.checkout_message_id),
        duplicate: true,
        fulfilled: true
      };
    }

    if (order.provider_payment_id && order.provider_payment_id !== chargeId) {
      throw new Error(`Charge ID mismatch for order #${orderId}.`);
    }

    if (order.order_status === "delivered" || order.payment_status === "paid") {
      await tx.commit();
      return { orderId, fulfilled: false, duplicate: true };
    }

    let configId = order.config_id ? Number(order.config_id) : null;
    let configText = order.config_text ? String(order.config_text) : null;

    const alreadyReserved =
      configId &&
      order.config_status === "reserved" &&
      Number(order.config_order_id) === orderId;

    if (!alreadyReserved) {
      const availableResult = await tx.execute({
        sql: `UPDATE configs
          SET status = 'sold', order_id = ?
          WHERE id = (
            SELECT id FROM configs
            WHERE product_id = ? AND status = 'available'
            ORDER BY id ASC LIMIT 1
          )
          AND status = 'available'
          RETURNING id, config_text`,
        args: [orderId, Number(order.product_id)]
      });

      const replacement = availableResult.rows[0];

      if (replacement) {
        configId = Number(replacement.id);
        configText = String(replacement.config_text);

        await tx.execute({
          sql: "UPDATE orders SET config_id = ? WHERE id = ?",
          args: [configId, orderId]
        });
      }
    } else {
      const soldResult = await tx.execute({
        sql: `UPDATE configs SET status = 'sold'
          WHERE id = ? AND status = 'reserved' AND order_id = ?`,
        args: [configId, orderId]
      });

      if (Number(soldResult.rowsAffected) !== 1) {
        throw new Error(`Could not finalize reserved config for order #${orderId}.`);
      }
    }

    if (!configId || !configText) {
      await tx.execute({
        sql: `UPDATE orders
          SET status = 'paid', paid_at = COALESCE(paid_at, datetime('now'))
          WHERE id = ?`,
        args: [orderId]
      });

      await tx.execute({
        sql: `UPDATE payments
          SET provider_payment_id = ?, status = 'paid', updated_at = datetime('now')
          WHERE order_id = ?`,
        args: [chargeId, orderId]
      });

      await tx.commit();
      return { orderId, fulfilled: false, duplicate: false };
    }

    await tx.execute({
      sql: `UPDATE orders
        SET status = 'delivered', config_id = ?,
            paid_at = COALESCE(paid_at, datetime('now')),
            delivered_at = COALESCE(delivered_at, datetime('now'))
        WHERE id = ?`,
      args: [configId, orderId]
    });

    await tx.execute({
      sql: `UPDATE payments
        SET provider_payment_id = ?, status = 'paid', updated_at = datetime('now')
        WHERE order_id = ?`,
      args: [chargeId, orderId]
    });

    await tx.commit();

    return {
      orderId,
      configText,
      checkoutChatId: order.checkout_chat_id,
      checkoutMessageId: order.checkout_message_id == null
        ? null
        : Number(order.checkout_message_id),
      duplicate: false,
      fulfilled: true
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
      }
