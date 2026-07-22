/**
 * ITPay Callback
 * Обновляет статус в Pyrus при оплате
 */

import { pyrusRequest, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const PYRUS_API = 'https://api.pyrus.com/v4';

/**
 * Ищет задачу по номеру заявки (текстовое поле, например "Т-685-7-26")
 * Возвращает task_id или null
 */
async function findTaskByOrderId(orderId) {
  try {
    // Ищем задачи в форме DIGITAL KASSA по тексту в названии
    const response = await fetch(`${PYRUS_API}/tasks/search?form_id=2450518`, {
      headers: {
        'Authorization': `Bearer ${await getPyrusTokenInternal()}`,
      },
    });
    const data = await response.json();

    if (data.tasks && data.tasks.length > 0) {
      // Ищем задачу у которой в заголовке или в поле ID 2 (Номер заявки) есть наш orderId
      for (const task of data.tasks) {
        if (task.text && task.text.includes(orderId)) {
          return task.id;
        }
        // Проверяем поле "Номер заявки" (ID 2)
        if (task.fields) {
          const orderField = task.fields.find(f => f.id === 2);
          if (orderField && orderField.value === orderId) {
            return task.id;
          }
        }
      }
    }
  } catch (e) {
    console.error('[SEARCH ERROR]', e.message);
  }
  return null;
}

let cachedToken = null;
let tokenExpires = 0;

async function getPyrusTokenInternal() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  const r = await fetch('https://accounts.pyrus.com/api/v4/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: process.env.PYRUS_LOGIN,
      security_key: process.env.PYRUS_SECURITY_KEY,
    }),
  });
  const d = await r.json();
  cachedToken = d.access_token;
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;
    const paymentData = data.data || data;

    const orderId = paymentData.client_payment_id;
    const status = paymentData.status;
    const amount = paymentData.amount;
    const currency = paymentData.currency || 'RUB';
    const paid = paymentData.paid;
    const paymentId = paymentData.id;

    console.log(`[ITPAY CALLBACK] order=${orderId}, status=${status}`);

    let taskId = null;
    if (orderId && typeof orderId === 'string') {
      if (orderId.startsWith('TASK-')) {
        taskId = orderId.replace('TASK-', '');
      } else if (/^\d+$/.test(orderId)) {
        // Числовой orderId = это taskId напрямую
        taskId = orderId;
      } else {
        // Текстовый orderId (например "Т-685-7-26") — ищем задачу в Pyrus
        console.log(`[ITPAY CALLBACK] Searching task by orderId: ${orderId}`);
        taskId = await findTaskByOrderId(orderId);
        console.log(`[ITPAY CALLBACK] Found task_id: ${taskId}`);
      }
    }

    if (!taskId) {
      console.log('[ITPAY CALLBACK] No task_id found, skipping');
      return res.status(200).json({ status: 0, message: 'No task_id' });
    }

    // Проверяем доступ
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      console.log(`[ITPAY CALLBACK] Task access error: ${taskRes.error}`);
      return res.status(200).json({ status: 0, message: taskRes.error || 'No task' });
    }

    let newStatus = '';
    let commentText = '';
    const successStatuses = ['paid', 'completed', 'success'];
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
    } else if (status === 'processing') {
      newStatus = '⏳ Обрабатывается';
      commentText = `⏳ Платёж обрабатывается\n🆔 ${paymentId}\n📋 ${orderId}`;
    } else {
      console.log(`[ITPAY CALLBACK] Unknown status: ${status}`);
      return res.status(200).json({ status: 0 });
    }

    await addCommentWithFieldUpdate(
      taskId,
      [{ id: 11, value: newStatus }],
      commentText
    );

    console.log(`[ITPAY CALLBACK] Updated task ${taskId} → ${newStatus}`);
    return res.status(200).json({ status: 0 });

  } catch (error) {
    console.error('[ITPAY CALLBACK] Error:', error);
    return res.status(200).json({ status: 0, error: error.message });
  }
}
