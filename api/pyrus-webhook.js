/**
 * Pyrus → ITPay
 * Полный flow с записью статуса в Pyrus
 */

import { pyrusRequest, getPyrusToken, updateTaskField, addComment } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

// ID полей формы Pyrus
const FIELD_LINK = 10;        // Ссылка для оплаты
const FIELD_STATUS = 11;      // Статус оплаты
const FIELD_ORDER_ID = 2;     // Номер заявки
const FIELD_PHONE = 4;        // Телефон
const FIELD_TABLE = 9;        // Таблица услуг
const FIELD_COST_CELL = 13;   // Ячейка "Стоимость" в таблице

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;
  console.log(`[PYRUS→ITPAY] task=${taskId}`);

  try {
    if (!taskId) {
      return res.status(400).json({ error: 'No task_id' });
    }

    // 1. Получаем полную задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error) {
      return res.status(403).json({ error: taskRes.error });
    }

    const task = taskRes.task;
    const fields = task.fields || [];

    // 2. Извлекаем простые поля
    const fieldMap = {};
    fields.forEach(f => {
      fieldMap[f.id] = f.value;
    });

    const phone = String(fieldMap[FIELD_PHONE] || '').replace(/\D/g, '');
    const orderId = fieldMap[FIELD_ORDER_ID] || `TASK-${taskId}`;

    // 3. Суммируем стоимость из таблицы услуг
    let totalAmount = 0;
    const servicesTable = fields.find(f => f.id === FIELD_TABLE);
    // Собираем позиции чека: [{ name, price, quantity, vat, type, object }]
    const receiptItems = [];
    if (servicesTable && Array.isArray(servicesTable.value)) {
      console.log(`[TABLE] rows: ${servicesTable.value.length}`);
      servicesTable.value.forEach((row, idx) => {
        if (row && Array.isArray(row.cells)) {
          // Ячейка 12 — название услуги, 13 — стоимость
          const nameCell = row.cells.find(c => c && c.id === 12);
          const costCell = row.cells.find(c => c && c.id === FIELD_COST_CELL);
          if (costCell && costCell.value !== null && costCell.value !== undefined && costCell.value !== '') {
            const val = parseFloat(String(costCell.value).replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(val) && val > 0) {
              totalAmount += val;
              // Название услуги (multiple_choice -> choice_names[0] или просто "Услуга X")
              let serviceName = 'Услуга';
              if (nameCell?.value?.choice_names && nameCell.value.choice_names.length > 0) {
                serviceName = nameCell.value.choice_names.join(', ');
              } else if (nameCell?.value) {
                serviceName = String(nameCell.value);
              }
              // Для 54-ФЗ: name <= 128, type=1 (предоплата), object=4 (услуга), vat=6 (без НДС)
              receiptItems.push({
                name: serviceName.substring(0, 128),
                price: val.toFixed(2),
                quantity: '1',
                vat: 6,       // НДС не облагается (УСН)
                type: 1,      // Предоплата 100%
                object: 4,    // Услуга
                unit_of_measurement: 'шт',
              });
              console.log(`[TABLE] row ${idx}: +${val} (${serviceName})`);
            }
          }
        }
      });
    }

    console.log(`[PYRUS→ITPAY] phone=${phone}, order=${orderId}, amount=${totalAmount}`);

    // 4. Проверяем сумму
    if (!totalAmount || totalAmount <= 0) {
      await updateTaskField(taskId, FIELD_STATUS, '❌ Сумма не указана');
      await addComment(taskId, '❌ Не удалось создать ссылку: сумма не указана или равна 0');
      return res.status(400).json({ error: 'amount is 0', totalAmount });
    }

    // Сразу пишем "В работе" чтобы видеть что Vercel обработал задачу
    await updateTaskField(taskId, FIELD_STATUS, '⏳ В работе');

    // 5. Создаём bill в ITPay
    const params = new URLSearchParams({
      amount: totalAmount.toFixed(2),
      order_id: orderId,
      description: `Оплата услуг АС Эксперт по заявке ${orderId}`,
      shop_id: process.env.ITPAY_SHOP_ID || '',
      type: 'normal',
      currency_in: 'RUB',
      payer_pays_commission: '1',
      locale: 'ru',
    });

    const itpayBody = {
      amount: totalAmount.toFixed(2),
      client_payment_id: orderId,
      description: `Оплата услуг АС Эксперт по заявке ${orderId}`,
      method: 'sbp',
      metadata: { pyrus_task_id: String(taskId) },
    };

    // items не передаём - ITPay сам формирует чек
    // (если нужно будет добавить - раскомментируй и поправь формат)

    const itpayRes = await fetch(`${ITPAY_API}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': ITPAY_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(itpayBody),
    });

    const itpay = await itpayRes.json();
    console.log(`[ITPAY] response:`, JSON.stringify(itpay).substring(0, 500));

    // Для gw.itpay.ru структура: { error: null, error_code: null, data: {id, payment_qr_urls, ...} }
    // Ошибка = error не null или error_code не null
    if (itpay.error || (itpay.error_code !== null && itpay.error_code !== undefined)) {
      const errMsg = itpay.error || itpay.message || JSON.stringify(itpay);
      await updateTaskField(taskId, FIELD_STATUS, '❌ Ошибка ITPay');
      await addComment(taskId, `❌ Ошибка ITPay:\n${errMsg}`);
      return res.status(500).json({ error: 'ITPay error', details: itpay });
    }

    if (!itpay.data?.id) {
      await updateTaskField(taskId, FIELD_STATUS, '❌ Нет ID');
      await addComment(taskId, `❌ ITPay не вернул ID платежа:\n${JSON.stringify(itpay).substring(0, 500)}`);
      return res.status(500).json({ error: 'No payment id' });
    }

    // 6. Пишем ссылку и статус в Pyrus
    // Для gw.itpay.ru ссылка находится в itpay.data.payment_qr_urls (JSON)
    let linkUrl = '';
    try {
      const qrUrls = typeof itpay.data?.payment_qr_urls === 'string'
        ? JSON.parse(itpay.data.payment_qr_urls)
        : itpay.data?.payment_qr_urls;
      linkUrl = qrUrls?.desktop || qrUrls?.android || qrUrls?.ios || '';
    } catch (e) {
      console.log('Failed to parse payment_qr_urls:', e.message);
    }
    if (!linkUrl) {
      // fallback - смотрим receipt link
      const receiptLink = itpay.data?.receipts?.[0]?.link_to_receipt;
      linkUrl = receiptLink || itpay.data?.payment_url || '';
    }
    if (!linkUrl) {
      await updateTaskField(taskId, FIELD_STATUS, '❌ Нет ссылки');
      await addComment(taskId, `❌ Не получили ссылку от ITPay:\n${JSON.stringify(itpay).substring(0, 500)}`);
      return res.status(500).json({ error: 'No link in ITPay response' });
    }
    await updateTaskField(taskId, FIELD_LINK, linkUrl);
    await updateTaskField(taskId, FIELD_STATUS, '⏳ Ждём оплату');

    // 7. Формируем красивый чек
    const receipt = itpay.data.receipts?.[0];
    const shop = itpay.data.shop;
    const items = receipt?.positions || [];
    const itemsText = items.map((p, i) => {
      const price = parseFloat(p.price) || 0;
      const qty = parseFloat(p.quantity) || 1;
      const total = price * qty;
      return `${i+1}. ${p.label}\n   ${qty} ${p.unit_of_measurement || 'шт'} × ${price.toFixed(2)} ₽ = ${total.toFixed(2)} ₽\n   ${p.vat_label || 'Без НДС'}`;
    }).join('\n\n') || '—';

    const totalSum = receipt?.total_sum || totalAmount.toFixed(2);
    const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
    const companyInn = receipt?.inn || shop?.legal_entity?.id || '';
    const companyAddress = shop?.address || receipt?.address || '344002, г. Ростов-на-Дону, ул. Социалистическая, 74, оф. 601';
    const created = (itpay.data.created || new Date().toISOString()).split('T')[0];
    const taxation = receipt?.taxation_system === 2 ? 'УСН (доход - расход)' : 'УСН';
    const customerEmail = receipt?.customer_email || 'oyyorel@aksiomins.ru';

    const receiptComment = `🏢 ${companyName}` +
      (companyInn ? `\n   ИНН: ${companyInn}` : '') +
      `\n   Адрес: ${companyAddress}\n` +
      `\n📋 Назначение: Оплата услуг АС Эксперт` +
      `\n                по заявке ${orderId}` +
      `\n📅 Дата: ${created}` +
      `\n💰 ИТОГО: ${parseFloat(totalSum).toFixed(2)} ₽` +
      `\n💳 Способ: СБП (Система быстрых платежей)` +
      `\n📊 Система налогообложения: ${taxation}\n` +
      `\n─────────────────────────────────────` +
      `\nТОВАРЫ / УСЛУГИ:` +
      `\n──────────────────────────────────────` +
      `\n${itemsText}` +
      `\n─────────────────────────────────────\n` +
      `\n🔗 QR-код для оплаты:` +
      `\n   ${linkUrl}\n` +
      `\n📱 Чек отправлен на: ${customerEmail}`;

    await addComment(taskId, receiptComment);

    return res.status(200).json({
      success: true,
      link_url: linkUrl,
      bill_id: itpay.bill_id || itpay.data?.id,
    });

  } catch (error) {
    console.error(`[ERROR]`, error);
    if (taskId) {
      try {
        await updateTaskField(taskId, FIELD_STATUS, '❌ Ошибка');
        await addComment(taskId, `❌ Ошибка: ${error.message}`);
      } catch (e) {}
    }
    return res.status(500).json({ error: error.message });
  }
}
