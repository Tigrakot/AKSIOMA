/**
 * PRODUCTION: Pyrus → ITPay
 * Полный flow:
 * 1. Pyrus webhook → Vercel
 * 2. Создаём bill в ITPay
 * 3. Пишем ссылку в поле ID 10
 * 4. Пишем статус в поле ID 11
 * 5. Добавляем комментарий
 */

import { pyrusRequest, getPyrusToken, updateTaskField, addComment } from './_pyrus-auth.js';

const ITPAY_API = 'https://itpay.app/api/v1';

// ID полей формы Pyrus
const FIELD_LINK = 10;        // Ссылка для оплаты
const FIELD_STATUS = 11;      // Статус оплаты
const FIELD_ORDER_ID = 2;     // Номер заявки
const FIELD_PHONE = 4;        // Телефон
const FIELD_SUM = 13;         // Стоимость (в таблице)

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
    console.log(`[PYRUS→ITPAY] form=${task.form_id}`);

    // 2. Извлекаем данные из полей
    const fields = task.fields || [];
    const fieldMap = {};
    fields.forEach(f => {
      fieldMap[f.id] = f.value;
      // Для табличных полей — собираем значения
      if (f.type === 'table' && f.value) {
        f.value.forEach((row, idx) => {
          row.forEach(cell => {
            fieldMap[`${f.id}_${cell.id}_${idx}`] = cell.value;
          });
        });
      }
    });

    // Достаём телефон, номер заявки, сумму
    const phone = String(fieldMap[FIELD_PHONE] || '').replace(/\D/g, '');
    const orderId = fieldMap[FIELD_ORDER_ID] || `TASK-${taskId}`;

    // Суммируем стоимость из таблицы услуг
    let totalAmount = 0;
    Object.keys(fieldMap).forEach(key => {
      if (key.startsWith(`${FIELD_SUM}_`)) {
        const val = parseFloat(fieldMap[key]);
        if (!isNaN(val)) totalAmount += val;
      }
    });

    console.log(`[PYRUS→ITPAY] phone=${phone}, order=${orderId}, amount=${totalAmount}`);

    if (!totalAmount || totalAmount <= 0) {
      await updateTaskField(taskId, FIELD_STATUS, '❌ Сумма не указана');
      await addComment(taskId, '❌ Не удалось создать ссылку: сумма не указана или равна 0');
      return res.status(400).json({ error: 'amount is 0' });
    }

    // 3. Создаём bill в ITPay
    const params = new URLSearchParams({
      amount: totalAmount.toFixed(2),
      order_id: orderId,
      description: `Оплата услуг АКСИОМА по заявке ${orderId}`,
      shop_id: process.env.ITPAY_SHOP_ID || '',
      type: 'normal',
      currency_in: 'RUB',
      payer_pays_commission: '1',
      locale: 'ru',
    });

    if (phone) params.set('payer_data[phone]', phone);

    const itpayRes = await fetch(`${ITPAY_API}/bill/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ITPAY_TOKEN || ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const itpay = await itpayRes.json();
    console.log(`[ITPAY] response:`, JSON.stringify(itpay));

    if (!itpay.success || !itpay.link_page_url) {
      const errMsg = itpay.message || JSON.stringify(itpay);
      await updateTaskField(taskId, FIELD_STATUS, '❌ Ошибка ITPay');
      await addComment(taskId, `❌ Ошибка при создании ссылки:\n${errMsg}`);
      return res.status(500).json({ error: 'ITPay error', details: itpay });
    }

    // 4. Пишем ссылку и статус в Pyrus
    await updateTaskField(taskId, FIELD_LINK, itpay.link_page_url);
    await updateTaskField(taskId, FIELD_STATUS, '⏳ Ждём оплату');

    // 5. Добавляем комментарий
    await addComment(
      taskId,
      `💳 Ссылка для оплаты создана!\n\n` +
      `🔗 ${itpay.link_page_url}\n\n` +
      `💰 Сумма: ${totalAmount} ₽\n` +
      `📋 Заявка: ${orderId}\n\n` +
      `После оплаты статус обновится автоматически.`
    );

    return res.status(200).json({
      success: true,
      link_url: itpay.link_page_url,
      bill_id: itpay.bill_id,
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
