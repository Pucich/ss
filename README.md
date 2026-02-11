# Lite → Full build switch (Unity WebGL shell)

Реализован независимый от Unity слой управления загрузкой:

- первый запуск: `lite` билд;
- фоновой прогрев `full` на уровне 3-4 (через `window.GameLevelReached(level)`) или по таймеру;
- при вызове `window.GameOver()` выполняется переключение в `full`;
- если `full` уже прогрет — переключение без экрана загрузки;
- если `full` не готов — показывается overlay загрузки;
- последующие запуски открывают `full` сразу при совпадении версии из манифеста.

## Файлы

- `builds-manifest.json` — версия и URL lite/full билдов.
- `build-orchestrator.js` — state machine, preloading, переключение.
- `index.html` — двухконтейнерный shell и overlay.

## Интеграция в текущий хостинг

1. Подставьте реальные пути в `builds-manifest.json`.
2. Оставьте ваш существующий progress bar и его callback; в orchestrator можно подключить ваш рендер прогресса внутри `updateOverlayProgress`.
3. Убедитесь, что lite билд вызывает `window.GameOver()` на 6 уровне (как уже реализовано у вас).
4. Если есть сигнал номера уровня из JS, прокиньте его в `window.GameLevelReached(level)`.

## Версионирование full билда

При смене версии `full.version` в манифесте старый флаг готовности автоматически сбрасывается,
и новый full прогревается заново.
