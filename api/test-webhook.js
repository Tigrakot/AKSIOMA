/**
 * TEST: Pyrus → Vercel
 * Логирует данные + получает полную задачу через API
 */

import { pyrusRequest, getPyrusToken } from './_pyrus-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('=== Pyrus Webhook ===');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', JSON.stringify(req.headers, null, 2));

  // Получаем task_id из тела или query
  const taskId = req.body?.task_id || req.body?.id || req.query?.task_id;

  let fullTask = null;
  let taskError = null;
  let formInfo = null;

  try {
    console.log('Getting token...');
    await getPyrusToken();

    if (taskId) {
      console.log('Fetching task:', taskId);
      fullTask = await pyrusRequest(`/tasks/${taskId}`);

      if (fullTask.task) {
        console.log('Task fields:');
        fullTask.task.fields?.forEach(f => {
          console.log(`  [${f.id}] ${f.name} (${f.type}):`, JSON.stringify(f.value));
        });
      }
    }

    // Получаем информацию о форме
    console.log('Fetching form info...');
    formInfo = await pyrusRequest(`/forms/2450518`);
    if (formInfo.form) {
      console.log('Form fields:');
      formInfo.form.fields?.forEach(f => {
        console.log(`  [${f.id}] ${f.name} (${f.type})`);
      });
    }

  } catch (err) {
    taskError = err.message;
    console.error('Error:', err);
  }

  return res.status(200).json({
    success: true,
    task_id: taskId,
    full_task: fullTask,
    task_error: taskError,
    form_info: formInfo,
  });
}
