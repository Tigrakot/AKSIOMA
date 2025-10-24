/**
 * Расширение "Фильтр текущего месяца"
 * Версия 1.1
 * Автор: ООО "АКСИОМА"
 * Описание: Добавляет кнопку 📅 для автоматической фильтрации задач
 * по дате создания — от начала до конца текущего месяца.
 */

Pyrus.Extensions.onLoad(function (context) {
  console.log("Расширение 'Фильтр текущего месяца' запущено", context);

  // --- Функция фильтрации задач ---
  function filterByCurrentMonth() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const toISO = (d) => d.toISOString().split("T")[0];

    // Находим кнопку фильтра по дате
    const filterButtons = [
      ...document.querySelectorAll('button[aria-label*="Дата создания"]'),
    ];

    if (filterButtons.length === 0) {
      alert('Поле "Дата создания" не найдено. Проверь, открыт ли реестр.');
      return;
    }

    // Открываем фильтр
    filterButtons[0].click();

    // Задержка, чтобы интерфейс успел отрисоваться
    setTimeout(() => {
      const inputs = document.querySelectorAll('input[type="date"]');
      if (inputs.length >= 2) {
        inputs[0].value = toISO(start);
        inputs[1].value = toISO(end);
        inputs[1].dispatchEvent(new Event("input"));
        inputs[1].dispatchEvent(new Event("change"));

        const apply = [...document.querySelectorAll("button")].find((b) =>
          /применить/i.test(b.textContent)
        );
        if (apply) apply.click();
      } else {
        alert("Не удалось найти поля фильтра дат.");
      }
    }, 600);
  }

  // --- Добавление кнопки в интерфейс ---
  function addButton() {
    if (document.querySelector("#monthFilterBtn")) return;

    const btn = document.createElement("button");
    btn.id = "monthFilterBtn";
    btn.textContent = "📅 Текущий месяц";
    btn.title = "Фильтровать задачи по текущему месяцу";
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: linear-gradient(135deg, #007aff, #00b37a);
      color: #fff;
      border-radius: 10px;
      padding: 10px 16px;
      font-size: 14px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 9999;
      transition: 0.3s;
    `;

    btn.onmouseover = () => (btn.style.opacity = 0.85);
    btn.onmouseout = () => (btn.style.opacity = 1);

    btn.onclick = filterByCurrentMonth;

    document.body.appendChild(btn);
  }

  // Запускаем добавление кнопки после загрузки страницы
  const ready = () => {
    if (document.readyState === "complete") addButton();
    else window.addEventListener("load", addButton);
  };

  ready();
});
