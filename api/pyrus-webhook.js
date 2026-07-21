      const qrUrls = typeof itpay.data?.payment_qr_urls === 'string'
        ? JSON.parse(itpay.data.payment_qr_urls)
        : itpay.data?.payment_qr_urls;
      linkUrl = qrUrls?.desktop || qrUrls?.android || qrUrls?.ios || '';
    } catch (e) {
      console.log('Failed to parse payment_qr_urls:', e.message);
    }
    if (!linkUrl) {
      // fallback - смотрим receipt link
      const receiptLink = itpay.data?.receipts?.[0]?.link_to_receipt;
      linkUrl = receiptLink || itpay.data?.payment_url || '';
    }
    if (!linkUrl) {
      await updateTaskField(taskId, FIELD_STATUS, '❌ Нет ссылки');
      await addComment(taskId, `❌ Не получили ссылку от ITPay:\n${JSON.stringify(itpay).substring(0, 500)}`);
      return res.status(500).json({ error: 'No link in ITPay response' });
    }
    await updateTaskField(taskId, FIELD_LINK, linkUrl);
    await updateTaskField(taskId, FIELD_STATUS, '⏳ Ждём оплату');
    // 7. Формируем красивый чек
    const receipt = itpay.data.receipts?.[0];
    const shop = itpay.data.shop;
    const items = receipt?.positions || [];
    const itemsText = items.map((p, i) => {
      const price = parseFloat(p.price) || 0;
      const qty = parseFloat(p.quantity) || 1;
      const total = price * qty;
      return `${i+1}. ${p.label}\n   ${qty} ${p.unit_of_measurement || 'шт'} × ${price.toFixed(2)} ₽ = ${total.toFixed(2)} ₽\n   ${p.vat_label || 'Без НДС'}`;
    }).join('\n\n') || '—';
    const totalSum = receipt?.total_sum || totalAmount.toFixed(2);
    const companyName = shop?.legal_entity?.name || 'ООО "АС ЭКСПЕРТ"';
    const companyInn = receipt?.inn || shop?.legal_entity?.id || '';
    const companyAddress = shop?.address || receipt?.address || '344002, г. Ростов-на-Дону, ул. Социалистическая, 74, оф. 601';
    const created = (itpay.data.created || new Date().toISOString()).split('T')[0];
    const taxation = receipt?.taxation_system === 2 ? 'УСН (доход - расход)' : 'УСН';
    const customerEmail = receipt?.customer_email || 'oyyorel@aksiomins.ru';
    const receiptComment = `🏢 ${companyName}` +
      (companyInn ? `\n   ИНН: ${companyInn}` : '') +
      `\n   Адрес: ${companyAddress}\n` +
      `\n📋 Назначение: Оплата услуг АС Эксперт` +
      `\n                по заявке ${orderId}` +
      `\n📅 Дата: ${created}` +
      `\n💰 ИТОГО: ${parseFloat(totalSum).toFixed(2)} ₽` +
      `\n💳 Способ: СБП (Система быстрых платежей)` +
      `\n📊 Система налогообложения: ${taxation}\n` +
      `\n─────────────────────────────────────` +
      `\nТОВАРЫ / УСЛУГИ:` +
      `\n──────────────────────────────────────` +
      `\n${itemsText}` +
      `\n─────────────────────────────────────\n` +
      `\n🔗 QR-код для оплаты:` +
      `\n   ${linkUrl}\n` +
      `\n📱 Чек отправлен на: ${customerEmail}`;
    await addComment(taskId, receiptComment);
    return res.status(200).json({
      success: true,
      link_url: linkUrl,
      bill_id: itpay.bill_id || itpay.data?.id,
    });
  } catch (error) {
    console.error(`[ERROR]`, error);
    if (taskId) {
      try {
        await updateTaskField(taskId, FIELD_STATUS, '❌ Ошибка');
        await addComment(taskId, `❌ Ошибка: ${error.message}`);
      } catch (e) {}
    }
    return res.status(500).json({ error: error.message });
  }
}
