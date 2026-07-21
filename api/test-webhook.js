/**
 * TEST: Pyrus → Vercel (без ITPay)
 * Принимает данные от Pyrus и пишет в лог + возвращает обратно
 * Поддерживает Basic Auth (логин:ключ) для Pyrus API
 */

// Pyrus использует Basic Auth
const PYRUS_LOGIN = process.env.PYRUS_LOGIN || 'bot@5e8cad2b-1648-4f62-a627-38786d8b31c6';
const PYRUS_API_KEY = process.env.PYRUS_API_KEY;
const PYRUS_AUTH = 'Basic ' + Buffer.from(`${PYRUS_LOGIN}:${PYRUS_API_KEY}`).toString('base64');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Логируем всё что пришло
  console.log('=== Pyrus Webhook Test ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=========================');

  // Если есть task_id - получаем полную задачу из Pyrus API
  let fullTask = null;
  const taskId = req.body?.task_id || req.body?.id;
  if (taskId) {
    try {
      const pyrusRes = await fetch(`https://api.pyrus.com/v4/tasks/${taskId}`, {
        headers: {
          'Authorization': PYRUS_AUTH,
        },
      });
      fullTask = await pyrusRes.json();
      console.log('Full task from Pyrus:', JSON.stringify(fullTask, null, 2));
    } catch (err) {
      console.log('Failed to get full task:', err.message);
    }
  }

  return res.status(200).json({
    success: true,
    message: 'Данные получены',
    received_body: req.body,
    full_task: fullTask,
  });
}
