/**
 * ITPay Callback
 * Обновляет статус в Pyrus при оплате
 * ВАЖНО: отвечаем 200 сразу, работу делаем после (Vercel timeout 30 сек)
 */

import { pyrusRequest, addCommentWithFieldUpdate, getPyrusToken } from './_pyrus-auth.js';

const PYRUS_API = 'https://api.pyrus.com/v4';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Отвечаем сразу! ITPay ждёт 200 в течение 30 сек
  res.status(200).json({ status: 0 });
  
  // Всю работу делаем после ответа
  try {
    await processWebhook(req.body);
  } catch (error) {
    console.error('[ITPAY CALLBACK] Error:', error.message);
  }
}

async function processWebhook(data) {
  const paymentData = data.data || data;

  const orderId = paymentData.client_payment_id;
  const status = paymentData.status;
  const amount = paymentData.amount;
  const currency = paymentData.currency || 'RUB';
  const paid = paymentData.paid;
  const paymentId = paymentData.id;
  const taskIdFromMeta = paymentData.metadata?.pyrus_task_id;

  console.log(`[ITPAY CALLBACK] order=${orderId}, status=${status}`);

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
      const token = await getPyrusToken();
      const formId = process.env.PYRUS_FORM_ID || '2450518';
      const registerRes = await fetch(
        `${PYRUS_API}/forms/${formId}/register`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const text = await registerRes.text();
      if (text) {
        const registerData = JSON.parse(text);
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

  // Получаем задачу
  const taskRes = await pyrusRequest(`/tasks/${taskId}`);
  if (taskRes.error || !taskRes.task) {
    console.log(`[ITPAY CALLBACK] Task ${taskId} access error: ${taskRes.error}`);
    return;
  }

  // Проверяем текущий статус
  const currentStatus = taskRes.task.fields?.find(f => f.id === 11)?.value || '';
  const successStatuses = ['paid', 'completed', 'success'];
  
  if (currentStatus.includes('Оплачено') && successStatuses.includes(status?.toLowerCase())) {
    console.log(`[ITPAY CALLBACK] Task ${taskId} already paid, skipping`);
    return;
  }

  // Определяем новый статус
  let newStatus = '';
  let commentText = '';
  const failedStatuses = ['cancelled', 'rejected', 'error', 'failed'];

  if (successStatuses.includes(status?.toLowerCase())) {
    newStatus = '✅ Оплачено';
    commentText = `💰 **ОПЛАТА ПОЛУЧЕНА!**\n\n` +
      `💵 Сумма: ${amount} ${currency}\n` +
      `📅 ${paid || new Date().toISOString()}\n` +
      `🆔 ${paymentId}\n📋 ${orderId}`;
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
