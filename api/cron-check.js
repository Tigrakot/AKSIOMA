import { getPyrusToken, addCommentWithFieldUpdate, uploadPyrusFile } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

const FIELD_LINK = 10;
const FIELD_STATUS = 11;
const FIELD_ORDER_ID = 2;
const FIELD_TABLE = 9;
const FIELD_COST_CELL = 13;
const FIELD_ITPAY_ID = 20;

// Проверка статуса платежа по ID (GET /v1/payments/{id})
async function checkItpayById(paymentId) {
  try {
    const res = await fetch(`${ITPAY_API}/payments/${paymentId}`, {
      headers: { 'Authorization': ITPAY_AUTH },
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`[POLL] Error ${paymentId}: ${res.status} ${text.substring(0, 100)}`);
      return null;
    }
    const data = await res.json();
    console.log(`[POLL] ${paymentId} → status=${data.status}`);
    return data;
  } catch (e) {
    console.error(`[POLL] Exception ${paymentId}: ${e.message}`);
    return null;
  }
}

// Скачать PDF чека
async function downloadReceipt(linkToReceipt) {
  if (!linkToReceipt) return null;
  try {
    const res = await fetch(linkToReceipt);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, filename: `Чек_${Date.now()}.pdf` };
  } catch (e) { return null; }
}

// Скачать PDF через receipt_id
async function fetchReceiptById(receiptId) {
  if (!receiptId) return null;
  try {
    const res = await fetch(`${ITPAY_API}/receipts/${receiptId}/`, {
      headers: { 'Authorization': ITPAY_AUTH },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.link_to_receipt) return await downloadReceipt(data.link_to_receipt);
    return null;
  } catch (e) { return null; }
}

// Обработать успешную оплату
async function processPayment(taskId, payment) {
  const paymentId = payment.id;
  const amount = payment.amount;
  const currency = payment.currency || 'RUB';
  const paid = payment.paid || payment.updated_at || new Date().toISOString();
  const orderId = payment.client_payment_id;
  const linkToReceipt = payment.link_to_receipt || payment.receipt_url || null;
  const receiptId = payment.receipt_id || payment.receipt?.id || null;

  console.log(`[POLL] Paid: task=${taskId}, payment=${paymentId}, amount=${amount}`);

  let attachmentGuids = [];
  let receipt = linkToReceipt ? await downloadReceipt(linkToReceipt) : await fetchReceiptById(receiptId);
  if (receipt) {
    try {
      const uploaded = await uploadPyrusFile(receipt.filename, receipt.buffer);
      attachmentGuids = [uploaded.guid];
    } catch (e) { console.log(`[POLL] Receipt upload failed: ${e.message}`); }
  }

  const commentText = `💰 **ОПЛАТА ПОЛУЧЕНА!**\n\n` +
    `💵 Сумма: ${amount} ${currency}\n` +
    `📅 ${paid}\n` +
    `🆔 ${paymentId}\n` +
    `📋 ${orderId}`;

  await addCommentWithFieldUpdate(
    taskId,
    [{ id: FIELD_STATUS, value: '✅ Оплачено' }],
    commentText,
    attachmentGuids.length > 0 ? attachmentGuids : null
  );
  return true;
}

// Кэш обрабатываемых задач (в RAM, сбрасывается при cold start)
const processingSet = new Set();

// ============================================================
// POLLING: проверяем задачи со статусом "ждём оплату"
// ============================================================
async function pollPending() {
  console.log('[POLL] Polling...');
  const token = await getPyrusToken();
  const formId = process.env.PYRUS_FORM_ID || '2450518';

  const res = await fetch(`https://api.pyrus.com/v4/forms/${formId}/register`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  const text = await res.text();
  if (!text) return { polled: 0, paid: 0 };

  const data = JSON.parse(text);
  const tasks = (data.tasks || []).filter(t => !processingSet.has(t.id));
  console.log(`[POLL] ${tasks.length} tasks`);
  let paidCount = 0;

  for (const task of tasks) {
    const taskId = task.id;
    const statusField = task.fields?.find(f => f.id === FIELD_STATUS);
    if (!statusField?.value?.includes('⏳')) continue;

    const itpayIdField = task.fields?.find(f => f.id === FIELD_ITPAY_ID);
    const itpayId = itpayIdField?.value;
    if (!itpayId) continue;

    if (processingSet.has(taskId)) continue;
    processingSet.add(taskId);

    const payment = await checkItpayById(itpayId);
    if (!payment) continue;

    const success = ['paid', 'processing', 'completed'].includes(payment.status);
    if (success) {
      await processPayment(taskId, payment);
      paidCount++;
    }
  }

  console.log(`[POLL] Done. Paid: ${paidCount}`);
  return { polled: tasks.length, paid: paidCount };
}

// ============================================================
// СОЗДАНИЕ ПЛАТЕЖЕЙ: создаём ссылку для оплаты
// ============================================================
async function createPayments() {
  console.log('[CRON] Creating payments...');
  const token = await getPyrusToken();
  const formId = process.env.PYRUS_FORM_ID || '2450518';

  const res = await fetch(`https://api.pyrus.com/v4/forms/${formId}/register`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  const text = await res.text();
  if (!text) return { created: 0 };

  const data = JSON.parse(text);
  const tasks = data.tasks || [];
  console.log(`[CRON] ${tasks.length} tasks`);
  let created = 0;

  for (const task of tasks) {
    const taskId = task.id;

    // Пропускаем если ссылка уже есть
    const linkField = task.fields?.find(f => f.id === FIELD_LINK);
    if (linkField?.value) continue;

    // Пропускаем если уже есть ITPay ID
    const itpayIdField = task.fields?.find(f => f.id === FIELD_ITPAY_ID);
    if (itpayIdField?.value) continue;

    // Пропускаем если уже оплачено
    const statusField = task.fields?.find(f => f.id === FIELD_STATUS);
    if (statusField?.value?.includes('✅')) continue;

    // Считаем сумму
    let total = 0;
    const table = task.fields?.find(f => f.id === FIELD_TABLE);
    if (table?.value && Array.isArray(table.value)) {
      for (const row of table.value) {
        if (row?.cells) {
          const costCell = row.cells.find(c => c?.id === FIELD_COST_CELL);
          if (costCell?.value) {
            const val = parseFloat(String(costCell.value).replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(val) && val > 0) total += val;
          }
        }
      }
    }
    if (total <= 0) continue;

    const orderField = task.fields?.find(f => f.id === FIELD_ORDER_ID);
    const orderId = orderField?.value || `TASK-${taskId}`;

    console.log(`[CRON] Creating: task=${taskId}, order=${orderId}, amount=${total}`);

    try {
      const itpayRes = await fetch(`${ITPAY_API}/payments`, {
        method: 'POST',
        headers: { 'Authorization': ITPAY_AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: total.toFixed(2),
          client_payment_id: orderId,
          description: `Оплата услуг АС Эксперт по заявке ${orderId}`,
          method: 'sbp',
          metadata: { pyrus_task_id: String(taskId) },
        }),
      });

      const itpay = await itpayRes.json();
      if (itpay.error || (itpay.error_code !== null && itpay.error_code !== undefined)) {
        console.error(`[CRON] ITPay error: ${itpay.error}`);
        continue;
      }
      if (!itpay.data?.id) continue;

      const itpayId = itpay.data.id;

      // Извлекаем ссылку
      let linkUrl = '';
      try {
        const qrUrls = typeof itpay.data.payment_qr_urls === 'string'
          ? JSON.parse(itpay.data.payment_qr_urls)
          : itpay.data.payment_qr_urls;
        linkUrl = qrUrls?.desktop || qrUrls?.android || qrUrls?.ios || '';
      } catch (e) {}
      if (!linkUrl) linkUrl = itpay.data.receipts?.[0]?.link_to_receipt || '';
      if (!linkUrl) continue;

      const receipt = itpay.data.receipts?.[0];
      const shop = itpay.data.shop;
      const items = receipt?.positions || [];
      const itemsText = items.map((p, i) => {
        const price = parseFloat(p.price) || 0;
        const qty = parseFloat(p.quantity) || 1;
        return `${i+1}. ${p.label}\n   ${qty} × ${price.toFixed(2)} ₽ = ${(price*qty).toFixed(2)} ₽`;
      }).join('\n') || '—';

      const totalSum = receipt?.total_sum || total.toFixed(2);
      const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
      const companyInn = receipt?.inn || '';

      const comment = `🏢 ${companyName}\n   ИНН: ${companyInn}\n` +
        `\n📋 Оплата услуг АС Эксперт по заявке ${orderId}` +
        `\n📅 ${new Date().toISOString().split('T')[0]} | 💰 ${parseFloat(totalSum).toFixed(2)} ₽ | 💳 СБП` +
        `\n\nТОВАРЫ:\n${itemsText}\n` +
        `\n🔗 ${linkUrl}`;

      await addCommentWithFieldUpdate(taskId, [
        { id: FIELD_LINK, value: linkUrl },
        { id: FIELD_STATUS, value: '⏳ Ждём оплату' },
        { id: FIELD_ITPAY_ID, value: itpayId },
      ], comment);

      console.log(`[CRON] ✓ task=${taskId}, payment=${itpayId}`);
      created++;
    } catch (err) {
      console.error(`[CRON] Error task ${taskId}: ${err.message}`);
    }
  }

  console.log(`[CRON] Done. Created: ${created}`);
  return { created };
}

export default async function handler(req, res) {
  try {
    const pollResult = await pollPending();
    const create = req.query.create === '1';
    const createResult = create ? await createPayments() : { created: 0 };

    return res.status(200).json({
      polled: pollResult.polled,
      paid: pollResult.paid,
      created: createResult.created,
    });
  } catch (error) {
    console.error('[CRON] Fatal:', error);
    return res.status(500).json({ error: error.message });
  }
}
