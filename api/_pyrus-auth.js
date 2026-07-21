/**
 * Pyrus API helper с авторизацией через /auth
 */

let cachedToken = null;
let tokenExpires = 0;

const PYRUS_LOGIN = process.env.PYRUS_LOGIN;
const PYRUS_SECURITY_KEY = process.env.PYRUS_SECURITY_KEY;

export async function getPyrusToken() {
  if (cachedToken && Date.now() < tokenExpires) {
    return cachedToken;
  }

  const response = await fetch('https://accounts.pyrus.com/api/v4/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: PYRUS_LOGIN,
      security_key: PYRUS_SECURITY_KEY,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Pyrus auth failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

export async function pyrusRequest(path, options = {}) {
  const token = await getPyrusToken();
  const response = await fetch(`https://api.pyrus.com/v4${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!text) {
    throw new Error(`Empty response from Pyrus API (status ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse Pyrus response: ${text.substring(0, 200)}`);
  }
}

/**
 * Обновить значение поля в задаче
 * @param {number} taskId - ID задачи
 * @param {number} fieldId - ID поля (10 = Ссылка, 11 = Статус)
 * @param {string} value - новое значение
 */
export async function updateTaskField(taskId, fieldId, value) {
  return pyrusRequest(`/tasks/${taskId}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: [
        { id: fieldId, value: value }
      ]
    }),
  });
}

/**
 * Добавить комментарий к задаче
 */
export async function addComment(taskId, text) {
  return pyrusRequest(`/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      text: text,
      attachments: [],
    }),
  });
}
