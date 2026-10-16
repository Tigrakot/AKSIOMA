/**
 * ITPay Callback
 * Обновляет статус в Pyrus при оплате + прикрепляет чек
 */

import { addCommentWithFieldUpdate, uploadPyrusFile, pyrusRequest } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

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

// Получить чек через ITPay API по receipt_id
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Отвечаем 200 СРАЗУ
  res.status(200).json({ status: 0 });
  res.end();

  // Работу делаем после ответа (асинхронно)
  try {
    await processWebhook(req.body);
  } catch (error) {
    console.error('[ITPAY CALLBACK] Error:', error.message);
  }
}

async function processWebhook(data) {
  const paymentData = data.data || data;
  const eventType = data.event || 'payment.completed'; // Тип события

  const orderId = paymentData.client_payment_id;
  const status = paymentData.status;
  const amount = paymentData.amount;
  const currency = paymentData.currency || 'RUB';
  const paid = paymentData.paid;
  const paymentId = paymentData.id;
  const taskIdFromMeta = paymentData.metadata?.pyrus_task_id;

  console.log(`[ITPAY CALLBACK] event=${eventType}, order=${orderId}, status=${status}`);

  if (!orderId) {
    console.log('[ITPAY CALLBACK] No orderId, skipping');
    return;
  }

  // Определяем taskId
  let taskId = null;
  if (taskIdFromMeta) {
    taskId = taskIdFromMeta;
    console.log(`[ITPAY CALLBACK] Got task_id from metadata: ${taskId}`);
  } else if (orderId && orderId.startsWith('TASK-')) {
    taskId = orderId.replace('TASK-', '');
  } else if (orderId && /^\d+$/.test(orderId)) {
    taskId = orderId;
  } else {
    // Ищем по номеру заявки
    try {
      const formId = process.env.PYRUS_FORM_ID || '2450518';
      const registerData = await pyrusRequest(`/forms/${formId}/register`);
      if (registerData.tasks) {
        const normalize = (s) => s ? s.replace(/-\d{4}$/, '').replace(/-\d{2}$/, '') : '';
        const orderIdNorm = normalize(orderId);

        for (const task of registerData.tasks || []) {
          const orderField = task.fields?.find(f => f.id === 2);
          if (orderField?.value) {
            if (orderField.value === orderId) {
              taskId = task.id;
              break;
            }
            const pyrusNorm = normalize(orderField.value);
            if (pyrusNorm && pyrusNorm === orderIdNorm) {
              taskId = task.id;
              break;
            }
          }
          if (!taskId && task.text?.includes(orderId)) {
            taskId = task.id;
            break;
          }
        }
      }
    } catch (searchErr) {
      console.error('[ITPAY CALLBACK] Search error:', searchErr.message);
    }
  }

  if (!taskId) {
    console.log(`[ITPAY CALLBACK] No task_id found for orderId=${orderId}`);
    return;
  }

  // Определяем новый статус
  let newStatus = '';
  let commentText = '';
  const successStatuses = ['paid', 'completed', 'success'];
  const failedStatuses = ['cancelled', 'rejected', 'error', 'failed'];
  
  // Проверяем receipt.state = completed — это тоже означает успешную оплату
  const receipts = paymentData.receipts || [];
  const completedReceipt = receipts.find(r => r.state === 'completed');
  const isPaidViaReceipt = !!completedReceipt;

  if (successStatuses.includes(status?.toLowerCase()) || isPaidViaReceipt) {
    newStatus = '✅ Оплачено';
    
    // Получаем ссылку на чек из receipts
    const receiptLink = completedReceipt?.link_to_receipt || receipts[0]?.link_to_receipt || '';
    
    commentText = `💰 **ОПЛАТА ПОЛУЧЕНА!**\n\n` +
      `💵 Сумма: ${amount} ${currency}\n` +
      `📅 ${paid || new Date().toISOString()}\n` +
      `🆔 ${paymentId}\n📋 ${orderId}` +
      (receiptLink ? `\n📄 Чек: ${receiptLink}` : '');
      
    // Скачиваем и прикрепляем PDF-чек
    let attachmentGuids = [];
    if (receiptLink || receipts[0]?.id) {
      let receipt = null;
      if (receiptLink) {
        receipt = await downloadReceipt(receiptLink);
      } else if (receipts[0]?.id) {
        receipt = await fetchReceiptById(receipts[0].id);
      }
      if (receipt) {
        try {
          const uploaded = await uploadPyrusFile(receipt.filename, receipt.buffer);
          attachmentGuids = [uploaded.guid];
          console.log(`[ITPAY CALLBACK] Receipt uploaded: ${receipt.filename}`);
        } catch (e) {
          console.error('[ITPAY CALLBACK] Receipt upload failed:', e.message);
        }
      }
    }
    
    await addCommentWithFieldUpdate(
      taskId,
      [{ id: 11, value: newStatus }],
      commentText,
      attachmentGuids.length > 0 ? attachmentGuids : null
    );
    
    console.log(`[ITPAY CALLBACK] Updated task ${taskId} → ${newStatus}`);
    return;
  } else if (failedStatuses.includes(status?.toLowerCase())) {
    newStatus = '❌ Ошибка оплаты';
    commentText = `❌ Ошибка оплаты: ${status}\n🆔 ${paymentId}\n📋 ${orderId}`;
  } else if (status === 'processing' || status === 'new') {
    newStatus = '⏳ Обрабатывается';
    commentText = `⏳ Платёж обрабатывается\n🆔 ${paymentId}\n📋 ${orderId}`;
  } else {
    console.log(`[ITPAY CALLBACK] Unknown status: ${status}`);
    return;
  }

  await addCommentWithFieldUpdate(
    taskId,
    [{ id: 11, value: newStatus }],
    commentText
  );

  console.log(`[ITPAY CALLBACK] Updated task ${taskId} → ${newStatus}`);
}
