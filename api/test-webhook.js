/**
 * TEST: Pyrus → Vercel (без ITPay)
 * Принимает данные от Pyrus и пишет в лог + возвращает обратно
 * Используй чтобы проверить что Pyrus правильно отправляет данные
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Логируем всё что пришло
  console.log('=== Pyrus Webhook Test ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Query:', JSON.stringify(req.query, null, 2));
  console.log('=========================');

  return res.status(200).json({
    success: true,
    message: 'Данные получены и залогированы',
    received: {
      method: req.method,
      body: req.body,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
    },
  });
}
