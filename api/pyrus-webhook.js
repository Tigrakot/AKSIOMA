/**
 * Pyrus → ITPay
 * Оптимизированная версия:
 * - 1 запрос к Pyrus вместо 2-3 (addComment с field_updates)
 * - Параллельные операции
 */

import { pyrusRequest, getPyrusToken, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

const FIELD_LINK = 10;
const FIELD_STATUS = 11;
const FIELD_ORDER_ID = 2;
const FIELD_PHONE = 4;
const FIELD_TABLE = 9;
const FIELD_COST_CELL = 13;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;

  try {
    if (!taskId) {
      return res.status(400).json({ error: 'No task_id' });
    }

    // Один запрос к Pyrus — получаем задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error) {
      return res.status(403).json({ error: taskRes.error });
    }

    const task = taskRes.task;
    const fields = task.fields || [];
    const fieldMap = {};
    fields.forEach(f => { fieldMap[f.id] = f.value; });

    const phone = String(fieldMap[FIELD_PHONE] || '').replace(/\D/g, '');
    const orderId = fieldMap[FIELD_ORDER_ID] || `TASK-${taskId}`;

    // Сумма из таблицы
    let totalAmount = 0;
    const servicesTable = fields.find(f => f.id === FIELD_TABLE);
    if (servicesTable && Array.isArray(servicesTable.value)) {
      servicesTable.value.forEach((row) => {
        if (row && Array.isArray(row.cells)) {
          const costCell = row.cells.find(c => c && c.id === FIELD_COST_CELL);
          if (costCell && costCell.value !== null && costCell.value !== undefined && costCell.value !== '') {
            const val = parseFloat(String(costCell.value).replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(val) && val > 0) totalAmount += val;
          }
        }
      });
    }

    if (!totalAmount || totalAmount <= 0) {
      // Один комментарий с обновлением статуса
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELD_STATUS, value: '❌ Сумма не указана' }],
        '❌ Не удалось создать ссылку: сумма не указана в таблице услуг'
      );
      return res.status(400).json({ error: 'amount is 0' });
    }

    // Создаём bill в ITPay
    const itpayRes = await fetch(`${ITPAY_API}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': ITPAY_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: totalAmount.toFixed(2),
        client_payment_id: orderId,
        description: `Оплата услуг АС Эксперт по заявке ${orderId}`,
        method: 'sbp',
        metadata: { pyrus_task_id: String(taskId) },
      }),
    });

    const itpay = await itpayRes.json();

    if (itpay.error || (itpay.error_code !== null && itpay.error_code !== undefined)) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELD_STATUS, value: '❌ Ошибка ITPay' }],
        `❌ Ошибка ITPay: ${itpay.error || JSON.stringify(itpay).substring(0, 500)}`
      );
      return res.status(500).json({ error: 'ITPay error', details: itpay });
    }

    if (!itpay.data?.id) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELD_STATUS, value: '❌ Нет ID' }],
        '❌ ITPay не вернул ID платежа'
      );
      return res.status(500).json({ error: 'No payment id' });
    }

    // Извлекаем ссылку
    let linkUrl = '';
    try {
      const qrUrls = typeof itpay.data.payment_qr_urls === 'string'
        ? JSON.parse(itpay.data.payment_qr_urls)
        : itpay.data.payment_qr_urls;
      linkUrl = qrUrls?.desktop || qrUrls?.android || qrUrls?.ios || '';
    } catch (e) {}
    if (!linkUrl) linkUrl = itpay.data.receipts?.[0]?.link_to_receipt || '';

    if (!linkUrl) {
      await addCommentWithFieldUpdate(
        taskId,
        [{ id: FIELD_STATUS, value: '❌ Нет ссылки' }],
        '❌ ITPay не вернул ссылку на оплату'
      );
      return res.status(500).json({ error: 'No link' });
    }

    // Формируем чек
    const receipt = itpay.data.receipts?.[0];
    const shop = itpay.data.shop;
    const items = receipt?.positions || [];
    const itemsText = items.map((p, i) => {
      const price = parseFloat(p.price) || 0;
      const qty = parseFloat(p.quantity) || 1;
      return `${i+1}. ${p.label}\n   ${qty} × ${price.toFixed(2)} ₽ = ${(price*qty).toFixed(2)} ₽\n   ${p.vat_label || 'Без НДС'}`;
    }).join('\n\n') || '—';

    const totalSum = receipt?.total_sum || totalAmount.toFixed(2);
    const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
    const companyInn = receipt?.inn || '';
    const companyAddress = shop?.address || receipt?.address || '';
    const created = (itpay.data.created || new Date().toISOString()).split('T')[0];
    const customerEmail = receipt?.customer_email || 'oyyorel@aksiomins.ru';

    const receiptComment = `🏢 ${companyName}` +
      (companyInn ? `\n   ИНН: ${companyInn}` : '') +
      (companyAddress ? `\n   Адрес: ${companyAddress}` : '') +
      `\n\n📋 Оплата услуг АС Эксперт по заявке ${orderId}` +
      `\n📅 ${created} | 💰 ${parseFloat(totalSum).toFixed(2)} ₽ | 💳 СБП\n` +
      `\nТОВАРЫ / УСЛУГИ:\n${itemsText}\n` +
      `\n🔗 ${linkUrl}\n📱 Чек: ${customerEmail}`;

    // ОДИН запрос: и комментарий, и обновление полей (ссылка + статус)
    await addCommentWithFieldUpdate(
      taskId,
      [
        { id: FIELD_LINK, value: linkUrl },
        { id: FIELD_STATUS, value: '⏳ Ждём оплату' },
      ],
      receiptComment
    );

    return res.status(200).json({
      success: true,
      link_url: linkUrl,
      bill_id: itpay.data.id,
    });

  } catch (error) {
    console.error(`[ERROR]`, error);
    if (taskId) {
      try {
        await addCommentWithFieldUpdate(
          taskId,
          [{ id: FIELD_STATUS, value: '❌ Ошибка' }],
          `❌ Ошибка: ${error.message}`
        );
      } catch (e) {}
    }
    return res.status(500).json({ error: error.message });
  }
}
