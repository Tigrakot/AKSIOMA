import { pyrusRequest, getPyrusToken, addCommentWithFieldUpdate, uploadPyrusFile } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

const FIELD_LINK = 10;
const FIELD_STATUS = 11;
const FIELD_ORDER_ID = 2;
const FIELD_TABLE = 9;
const FIELD_COST_CELL = 13;

// Проверяем статус платежа через ITPay API по client_payment_id
async function checkItpayPayment(orderId) {
  try {
    const res = await fetch(`${ITPAY_API}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': ITPAY_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_payment_id: orderId }),
    });

    if (!res.ok) {
      console.log(`[POLL] ITPay API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    console.log(`[POLL] order=${orderId}, ITPay response:`, JSON.stringify(data).substring(0, 200));

    const payments = data.data?.items || data.data || [];
    if (!Array.isArray(payments)) {
      if (data.data?.id) return data.data;
      return null;
    }

    return payments.find(p =>
      p.client_payment_id === orderId &&
      ['paid', 'completed', 'success'].includes(p.status?.toLowerCase())
    ) || null;
  } catch (e) {
    console.error(`[POLL] Error checking ITPay for ${orderId}:`, e.message);
    return null;
  }
}

// Скачать PDF-чек по ссылке
async function downloadReceipt(linkToReceipt) {
  if (!linkToReceipt) return null;
  try {
    const res = await fetch(linkToReceipt);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, filename: `Чек_${Date.now()}.pdf` };
  } catch (e) {
    return null;
  }
}

// Скачать PDF-чек через ITPay API по receipt_id
async function fetchReceiptById(receiptId) {
  if (!receiptId) return null;
  try {
    const res = await fetch(`${ITPAY_API}/receipts/${receiptId}/`, {
      headers: { 'Authorization': ITPAY_AUTH },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.link_to_receipt) {
      return await downloadReceipt(data.link_to_receipt);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Обработать успешную оплату: обновить статус и приложить чек
async function processPayment(taskId, payment) {
  const paymentId = payment.id;
  const amount = payment.amount;
  const currency = payment.currency || 'RUB';
  const paid = payment.paid || payment.updated_at || new Date().toISOString();
  const orderId = payment.client_payment_id;
  const linkToReceipt = payment.link_to_receipt || payment.receipt_url || null;
  const receiptId = payment.receipt_id || payment.receipt?.id || null;

  console.log(`[POLL] Payment success: task=${taskId}, payment=${paymentId}, amount=${amount}`);

  let attachmentGuids = [];
  let receipt = null;
  if (linkToReceipt) {
    receipt = await downloadReceipt(linkToReceipt);
  } else if (receiptId) {
    receipt = await fetchReceiptById(receiptId);
  }

  if (receipt) {
    try {
      const uploaded = await uploadPyrusFile(receipt.filename, receipt.buffer);
      attachmentGuids = [uploaded.guid];
      console.log(`[POLL] Receipt uploaded: ${receipt.filename}`);
    } catch (e) {
      console.error('[POLL] Receipt upload failed:', e.message);
    }
  } else {
    console.log('[POLL] No receipt available yet');
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

  console.log(`[POLL] Task ${taskId} updated → ✅ Оплачено`);
  return true;
}

// In-memory кэш задач которые уже в процессе обработки
const processingSet = new Set();

// In-memory кэш задач которые уже отправлены на оплату
const sentPayments = new Map();

// ============================================================
// POLLING: проверяем задачи которые ждут оплату
// ============================================================
async function pollPendingPayments() {
  console.log('[POLL] === Polling started ===');
  const token = await getPyrusToken();
  const formId = process.env.PYRUS_FORM_ID || '2450518';

  const registerRes = await fetch(
    `https://api.pyrus.com/v4/forms/${formId}/register`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const text = await registerRes.text();
  if (!text) {
    console.log('[POLL] No tasks received');
    return { polled: 0, paid: 0 };
  }

  const data = JSON.parse(text);
  const tasks = (data.tasks || []).filter(t => !processingSet.has(t.id));
  console.log(`[POLL] Checking ${tasks.length} tasks for pending payments`);

  let paidCount = 0;

  for (const task of tasks) {
    const taskId = task.id;
    const statusField = task.fields?.find(f => f.id === FIELD_STATUS);
    const status = statusField?.value || '';

    if (!status.includes('⏳')) continue;

    const linkField = task.fields?.find(f => f.id === FIELD_LINK);
    if (!linkField?.value) continue;

    const orderField = task.fields?.find(f => f.id === FIELD_ORDER_ID);
    const orderId = orderField?.value || `TASK-${taskId}`;

    console.log(`[POLL] Checking task ${taskId}, order=${orderId}`);

    const payment = await checkItpayPayment(orderId);

    if (payment) {
      processingSet.add(taskId);
      try {
        const updated = await processPayment(taskId, payment);
        if (updated) paidCount++;
      } finally {
        setTimeout(() => processingSet.delete(taskId), 5 * 60 * 1000);
      }
    }
  }

  console.log(`[POLL] === Done. Paid: ${paidCount} ===`);
  return { polled: tasks.length, paid: paidCount };
}

// ============================================================
// СОЗДАНИЕ ПЛАТЕЖЕЙ: отправляем ссылку на оплату
// ============================================================
async function createPayments() {
  console.log('[CRON] === Creating payments ===');
  const token = await getPyrusToken();
  const formId = process.env.PYRUS_FORM_ID || '2450518';

  const registerRes = await fetch(
    `https://api.pyrus.com/v4/forms/${formId}/register`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const text = await registerRes.text();
  if (!text) return { created: 0 };

  const data = JSON.parse(text);
  const tasks = data.tasks || [];
  console.log(`[CRON] Got ${tasks.length} tasks`);

  const results = [];

  for (const task of tasks) {
    const taskId = task.id;

    const linkField = task.fields?.find(f => f.id === FIELD_LINK);
    if (linkField?.value) continue;

    if (sentPayments.has(taskId)) continue;

    const statusField = task.fields?.find(f => f.id === FIELD_STATUS);
    const status = statusField?.value || '';
    if (status.includes('✅')) continue;

    let totalAmount = 0;
    const servicesTable = task.fields?.find(f => f.id === FIELD_TABLE);
    if (servicesTable?.value && Array.isArray(servicesTable.value)) {
      for (const row of servicesTable.value) {
        if (row?.cells) {
          const costCell = row.cells.find(c => c?.id === FIELD_COST_CELL);
          if (costCell?.value) {
            const val = parseFloat(String(costCell.value).replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(val) && val > 0) totalAmount += val;
          }
        }
      }
    }
    if (totalAmount <= 0) continue;

    const orderField = task.fields?.find(f => f.id === FIELD_ORDER_ID);
    const orderId = orderField?.value || `TASK-${taskId}`;

    console.log(`[CRON] Creating payment: task=${taskId}, order=${orderId}, amount=${totalAmount}`);

    try {
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
        console.error(`[CRON] ITPay error:`, itpay.error);
        continue;
      }

      if (!itpay.data?.id) continue;

      const itpayPaymentId = itpay.data.id;
      sentPayments.set(taskId, itpayPaymentId);

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

      const totalSum = receipt?.total_sum || totalAmount.toFixed(2);
      const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
      const companyInn = receipt?.inn || '';

      const comment = `🏢 ${companyName}\n   ИНН: ${companyInn}\n` +
        `\n📋 Оплата услуг АС Эксперт по заявке ${orderId}` +
        `\n📅 ${new Date().toISOString().split('T')[0]} | 💰 ${parseFloat(totalSum).toFixed(2)} ₽ | 💳 СБП` +
        `\n\nТОВАРЫ:\n${itemsText}\n` +
        `\n🔗 ${linkUrl}`;

      await addCommentWithFieldUpdate(
        taskId,
        [
          { id: FIELD_LINK, value: linkUrl },
          { id: FIELD_STATUS, value: '⏳ Ждём оплату' },
        ],
        comment
      );

      results.push({ taskId, success: true, paymentId: itpayPaymentId });
      console.log(`[CRON] ✓ task=${taskId}, payment=${itpayPaymentId}`);
    } catch (err) {
      console.error(`[CRON] Error for task ${taskId}:`, err.message);
    }
  }

  console.log(`[CRON] === Done. Created: ${results.length} ===`);
  return { created: results.length };
}

export default async function handler(req, res) {
  try {
    const pollResult = await pollPendingPayments();

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
