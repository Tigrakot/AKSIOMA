/**
 * Pyrus API helper с авторизацией через /auth
 * Возвращает access_token, кэширует на 23 часа
 */

let cachedToken = null;
let tokenExpires = 0;

const PYRUS_LOGIN = process.env.PYRUS_LOGIN;
const PYRUS_SECURITY_KEY = process.env.PYRUS_SECURITY_KEY;

export async function getPyrusToken() {
  // Если токен ещё валиден — используем его
  if (cachedToken && Date.now() < tokenExpires) {
    return cachedToken;
  }

  // Получаем новый
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
  // Токен живёт 24 часа, обновляем за час до конца
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  return cachedToken;
}

export async function pyrusRequest(path) {
  const token = await getPyrusToken();
  const response = await fetch(`https://api.pyrus.com/v4${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return response.json();
}
