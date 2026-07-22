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
    throw new Error(`Pyrus auth failed: ${response.status}`);
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
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Parse error: ${text.substring(0, 200)}`);
  }
}

export async function addCommentWithFieldUpdate(taskId, fieldUpdates, text) {
  const token = await getPyrusToken();
  const body = { text };
  if (fieldUpdates && fieldUpdates.length > 0) {
    body.field_updates = fieldUpdates;
  }
  const response = await fetch(`https://api.pyrus.com/v4/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const t = await response.text();
  if (!t) return {};
  return JSON.parse(t);
}
