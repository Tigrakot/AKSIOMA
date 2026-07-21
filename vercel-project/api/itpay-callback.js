/**
 * ITPay Callback
 * Обновляет статус оплаты в Pyrus
 */

const PYRUS_API = 'https://api.pyrus.com/v4';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;
    console.log('ITPay callback:', JSON.stringify(data, null, 2));

    // Статусы ITPay → статусы Pyrus
    const statusText = {
      'SUCCESS': '✅ ОПЛАЧЕНО',
      'FAIL': '❌ ОШИБКА',
      'PROCESS': '⏳ ОБРАБОТКА',
    };

    const status = statusText[data.Status] || `Статус: ${data.Status}`;
    const orderId = data.InvId;

    // Извлекаем task_id из order_id
    let taskId = orderId;
    if (orderId.startsWith('TASK-')) {
      taskId = orderId.replace('TASK-', '');
    }

    // Добавляем комментарий в Pyrus
    const message = `💰 ${status}\n` +
      `Сумма: ${data.OutSum} ${data.CurrencyIn || 'RUB'}\n` +
      (data.Commission ? `Комиссия: ${data.Commission}` : '');

    await fetch(`${PYRUS_API}/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PYRUS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: message,
        attachments: [],
      }),
    });

    // ITPay требует ответ {status: 0}
    return res.status(200).json({ status: 0 });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ status: 0, error: error.message });
  }
}
