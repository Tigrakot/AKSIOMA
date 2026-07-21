# Pyrus + ITPay Integration

Webhook-мост для автоматического создания ссылок на оплату.

## Endpoints

- `POST /api/pyrus-webhook` — принимает данные из Pyrus → создаёт ссылку в ITPay
- `POST /api/itpay-callback` — принимает уведомления об оплате от ITPay

## Setup

### 1. Vercel Environment Variables

```
PYRUS_TOKEN=<your_pyrus_token>
PYRUS_FORM_ID=2450518
ITPAY_TOKEN=<your_itpay_token>
ITPAY_SHOP_ID=<your_shop_id>
```

### 2. Pyrus Webhook

URL: `https://<your-project>.vercel.app/api/pyrus-webhook`

### 3. ITPay Result URL

URL: `https://<your-project>.vercel.app/api/itpay-callback`
