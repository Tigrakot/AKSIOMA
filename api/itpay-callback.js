/**
 * ITPay Callback
 * Обновляет статус в Pyrus при оплате
 */

import { pyrusRequest, addCommentWithFieldUpdate, getPyrusToken } from './_pyrus-auth.js';

const PYRUS_API = 'https://api.pyrus.com/v4';

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
    // task_id может прийти в metadata (если ITpay его передаёт)
    const taskIdFromMeta = paymentData.metadata?.pyrus_task_id;

    console.log(`[ITPAY CALLBACK] order=${orderId}, status=${status}`);

    if (!orderId) {
      console.log('[ITPAY CALLBACK] No orderId, skipping');
      return res.status(200).json({ status: 0, message: 'No orderId' });
    }

    // Если orderId = "TASK-123" → taskId = "123"
    let taskId = null;
    if (taskIdFromMeta) {
      taskId = taskIdFromMeta;
      console.log(`[ITPAY CALLBACK] Got task_id from metadata: ${taskId}`);
    } else if (orderId && orderId.startsWith('TASK-')) {
      taskId = orderId.replace('TASK-', '');
    } else if (orderId && /^\d+$/.test(orderId)) {
      taskId = orderId;
    } else {
      // orderId = текстовый номер заявки ("Т-685-7-26")
      // Получаем реестр задач формы (все задачи) и ищем по номеру
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
          console.log(`[ITPAY CALLBACK] Register returned ${registerData.tasks?.length || 0} tasks`);

          if (registerData.tasks && registerData.tasks.length > 0) {
            // Нормализуем orderId для сравнения (убираем год "-20XX" в конце)
            // "3002-07-26" → "3002-07", "3002-07-2026" → "3002-07"
            const normalize = (s) => s ? s.replace(/-\d{4}$/, '').replace(/-\d{2}$/, '') : '';
            const orderIdNorm = normalize(orderId);

            for (const task of registerData.tasks) {
              if (task.fields) {
                const orderField = task.fields.find(f => f.id === 2);
                if (orderField && orderField.value) {
                  if (orderField.value === orderId) {
                    taskId = task.id;
                    console.log(`[ITPAY CALLBACK] Found exact: ${taskId}`);
                    break;
                  }
                  const pyrusNorm = normalize(orderField.value);
                  if (pyrusNorm && pyrusNorm === orderIdNorm) {
                    taskId = task.id;
                    console.log(`[ITPAY CALLBACK] Found by normalized match: ${taskId} (${orderField.value} ~ ${orderId})`);
                    break;
                  }
                }
              }
              if (!taskId && task.text && task.text.includes(orderId)) {
                taskId = task.id;
                console.log(`[ITPAY CALLBACK] Found in title: ${taskId}`);
                break;
              }
            }
          }
        }
      } catch (searchErr) {
        console.error('[ITPAY CALLBACK] Search error:', searchErr.message);
      }
    }

    if (!taskId) {
      console.log(`[ITPAY CALLBACK] No task_id found for orderId=${orderId}`);
      return res.status(200).json({ status: 0, message: 'No task_id' });
    }

    // Получаем задачу для проверки доступа
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      console.log(`[ITPAY CALLBACK] Task ${taskId} access error: ${taskRes.error}`);
      return res.status(200).json({ status: 0, message: taskRes.error || 'No task' });
    }

    // Проверяем текущий статус — если уже "Оплачено", пропускаем
    const currentStatus = taskRes.task.fields?.find(f => f.id === 11)?.value || '';
    const successStatuses = ['paid', 'completed', 'success'];
    if (currentStatus.includes('Оплачено') && successStatuses.includes(status?.toLowerCase())) {
      console.log(`[ITPAY CALLBACK] Task ${taskId} already paid, skipping duplicate`);
      return res.status(200).json({ status: 0, message: 'Already paid' });
    }

    // Определяем статус
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
