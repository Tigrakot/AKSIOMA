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

    console.log(`[ITPAY CALLBACK] order=${orderId}, status=${status}`);

    if (!orderId) {
      console.log('[ITPAY CALLBACK] No orderId, skipping');
      return res.status(200).json({ status: 0, message: 'No orderId' });
    }

    // Если orderId = "TASK-123" → taskId = "123"
    let taskId = null;
    if (orderId.startsWith('TASK-')) {
      taskId = orderId.replace('TASK-', '');
    } else if (/^\d+$/.test(orderId)) {
      taskId = orderId;
    } else {
      // orderId = текстовый номер заявки ("Т-685-7-26")
      // Ищем задачу через поиск Pyrus API
      try {
        const token = await getPyrusToken();
        // Используем search endpoint
        const searchRes = await fetch(
          `${PYRUS_API}/tasks?form_id=2450518`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const searchData = await searchRes.json();
        console.log(`[ITPAY CALLBACK] Search returned ${searchData.tasks?.length || 0} tasks`);

        if (searchData.tasks && searchData.tasks.length > 0) {
          for (const task of searchData.tasks) {
            // Проверяем title (там обычно есть "DIGITAL KASSA: <НомерЗаявки>")
            if (task.text && task.text.includes(orderId)) {
              taskId = task.id;
              console.log(`[ITPAY CALLBACK] Found in title: ${taskId}`);
              break;
            }
            // Или проверяем поле "Номер заявки" (ID 2)
            if (task.fields) {
              const orderField = task.fields.find(f => f.id === 2);
              if (orderField && orderField.value && orderField.value.includes(orderId)) {
                taskId = task.id;
                console.log(`[ITPAY CALLBACK] Found in field 2: ${taskId}`);
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

    // Определяем статус
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
