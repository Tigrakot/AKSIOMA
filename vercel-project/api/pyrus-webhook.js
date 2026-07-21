/**
 * Pyrus → ITPay Webhook
 * Создаёт ссылку на оплату при получении данных из Pyrus
 */

const PYRUS_API = 'https://api.pyrus.com/v4';
const ITPAY_API = 'https://itpay.app/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;
    console.log('Pyrus webhook:', JSON.stringify(data, null, 2));

    const taskId = data.task_id || data.id;
    const amount = data.amount || extractAmount(data);
    const orderId = data.order_id || `TASK-${taskId}`;
    const phone = extractPhone(data);
    const description = data.description || 'Оплата услуг АКСИОМА';

    if (!taskId || !amount) {
      return res.status(400).json({ error: 'Missing task_id or amount' });
    }

    // Создаём bill в ITPay
    const params = new URLSearchParams({
      amount: amount,
      order_id: orderId,
      description: description,
      shop_id: process.env.ITPAY_SHOP_ID,
      type: 'normal',
      currency_in: 'RUB',
      payer_pays_commission: '1',
      locale: 'ru',
    });

    if (phone) params.set('payer_data[phone]', phone);

    const itpayRes = await fetch(`${ITPAY_API}/bill/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ITPAY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const itpay = await itpayRes.json();
    console.log('ITPay response:', itpay);

    if (!itpay.success || !itpay.link_page_url) {
      return res.status(500).json({ error: 'ITPay error', details: itpay });
    }

    // Записываем ссылку в Pyrus через комментарий
    await fetch(`${PYRUS_API}/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PYRUS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: `🔗 Ссылка для оплаты:\n${itpay.link_page_url}`,
        attachments: [],
      }),
    });

    return res.status(200).json({
      success: true,
      link_url: itpay.link_page_url,
      bill_id: itpay.bill_id,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function extractAmount(data) {
  return data.amount
    || data.fields?.amount
    || data.fields?.итого
    || null;
}

function extractPhone(data) {
  const phone = data.phone
    || data.fields?.phone
    || data.fields?.телефон
    || '';
  return phone.replace(/\D/g, '');
}
