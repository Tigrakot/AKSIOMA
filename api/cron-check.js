import { pyrusRequest, getPyrusToken, addCommentWithFieldUpdate } from './_pyrus-auth.js';

const ITPAY_API = 'https://api.gw.itpay.ru/v1';
const ITPAY_PUBLIC_ID = process.env.ITPAY_PUBLIC_ID;
const ITPAY_API_SECRET = process.env.ITPAY_API_SECRET;
const ITPAY_AUTH = 'Basic ' + Buffer.from(`${ITPAY_PUBLIC_ID}:${ITPAY_API_SECRET}`).toString('base64');

const FIELD_LINK = 10;
const FIELD_STATUS = 11;
const FIELD_ORDER_ID = 2;
const FIELD_TABLE = 9;
const FIELD_COST_CELL = 13;

const processedCache = new Set();

export default async function handler(req, res) {
  try {
    console.log('[CRON] Check started');
    const token = await getPyrusToken();
    const formId = process.env.PYRUS_FORM_ID || '2450518';

    const registerRes = await fetch(
      `https://api.pyrus.com/v4/forms/${formId}/register`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const text = await registerRes.text();
    if (!text) {
      return res.status(200).json({ processed: 0 });
    }
    const data = JSON.parse(text);
    const tasks = data.tasks || [];
    console.log(`[CRON] Got ${tasks.length} tasks`);

    const results = [];

    for (const task of tasks) {
      const taskId = task.id;
      if (processedCache.has(taskId)) continue;

      const linkField = task.fields?.find(f => f.id === FIELD_LINK);
      if (linkField?.value) {
        processedCache.add(taskId);
        continue;
      }

      let totalAmount = 0;
      const servicesTable = task.fields?.find(f => f.id === FIELD_TABLE);
      if (servicesTable?.value && Array.isArray(servicesTable.value)) {
        for (const row of servicesTable.value) {
          if (row?.cells) {
            const costCell = row.cells.find(c => c?.id === FIELD_COST_CELL);
            if (costCell?.value) {
              const val = parseFloat(String(costCell.value).replace(/\s/g, '').replace(',', '.'));
              if (!isNaN(val) && val > 0) totalAmount += val;
            }
          }
        }
      }

      if (totalAmount <= 0) continue;

      const orderField = task.fields?.find(f => f.id === FIELD_ORDER_ID);
      const orderId = orderField?.value || `TASK-${taskId}`;

      console.log(`[CRON] Processing ${taskId}, order=${orderId}, amount=${totalAmount}`);

      try {
        const itpayRes = await fetch(`${ITPAY_API}/payments`, {
          method: 'POST',
          headers: {
            'Authorization': ITPAY_AUTH,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: totalAmount.toFixed(2),
            client_payment_id: orderId,
            description: `Оплата услуг АС Эксперт по заявке ${orderId}`,
            method: 'sbp',
            metadata: { pyrus_task_id: String(taskId) },
          }),
        });

        const itpay = await itpayRes.json();

        if (itpay.error || (itpay.error_code !== null && itpay.error_code !== undefined)) {
          console.error(`[CRON] ITPay error:`, itpay.error);
          continue;
        }

        if (!itpay.data?.id) continue;

        let linkUrl = '';
        try {
          const qrUrls = typeof itpay.data.payment_qr_urls === 'string'
            ? JSON.parse(itpay.data.payment_qr_urls)
            : itpay.data.payment_qr_urls;
          linkUrl = qrUrls?.desktop || qrUrls?.android || qrUrls?.ios || '';
        } catch (e) {}
        if (!linkUrl) linkUrl = itpay.data.receipts?.[0]?.link_to_receipt || '';

        if (!linkUrl) continue;

        const receipt = itpay.data.receipts?.[0];
        const shop = itpay.data.shop;
        const items = receipt?.positions || [];
        const itemsText = items.map((p, i) => {
          const price = parseFloat(p.price) || 0;
          const qty = parseFloat(p.quantity) || 1;
          return `${i+1}. ${p.label}\n   ${qty} × ${price.toFixed(2)} ₽ = ${(price*qty).toFixed(2)} ₽`;
        }).join('\n') || '—';

        const totalSum = receipt?.total_sum || totalAmount.toFixed(2);
        const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
        const companyInn = receipt?.inn || '';

        const comment = `🏢 ${companyName}\n   ИНН: ${companyInn}\n` +
          `\n📋 Оплата услуг АС Эксперт по заявке ${orderId}` +
          `\n📅 ${new Date().toISOString().split('T')[0]} | 💰 ${parseFloat(totalSum).toFixed(2)} ₽ | 💳 СБП` +
          `\n\nТОВАРЫ:\n${itemsText}\n` +
          `\n🔗 ${linkUrl}`;

        await addCommentWithFieldUpdate(
          taskId,
          [
            { id: FIELD_LINK, value: linkUrl },
            { id: FIELD_STATUS, value: '⏳ Ждём оплату' },
          ],
          comment
        );

        processedCache.add(taskId);
        results.push({ taskId, success: true });
        console.log(`[CRON] ✓ ${taskId}`);
      } catch (err) {
        console.error(`[CRON] Error:`, err.message);
      }
    }

    return res.status(200).json({ processed: results.length, results });

  } catch (error) {
    console.error('[CRON] Fatal:', error);
    return res.status(500).json({ error: error.message });
  }
}
