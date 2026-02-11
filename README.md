# Lite → Full build switch (Unity WebGL shell)

Реализован независимый JS/HTML слой для последовательной загрузки:

- старт всегда с `lite`;
- `full` начинает прогреваться в фоне с 3 уровня (`window.GameLevelReached(level)`) или по fallback-таймеру;
- на 6 уровне (или по `window.GameOver()`) идёт переход в `full`;
- если `full` уже готов, переход без паузы;
- если есть задержка — остаётся текущее изображение игры + маленький CSS-спиннер в правом нижнем углу (без прогресс-бара);
- состояние готовности full кэшируется по версии из манифеста.

## Файлы

- `builds-manifest.json` — **единая точка настройки**: версии, директории, имена ассетов, уровни и тайминги переключения.
- `build-orchestrator.js` — state machine: запуск lite, фоновый warmup full, handover без миганий.
- `index.html` — shell с двумя canvas и overlay-спиннером.

## Что можно менять без правок кода

В `builds-manifest.json`:

- директории билдов (`baseDir`);
- имена файлов (`loader/data/framework/wasm`);
- версии (`version`);
- момент старта прогрева/переключения (`warmupStartLevel`, `switchLevel`);
- ограничение ожидания handover (`maxHandoverWaitMs`, целевое ~14с).

## Интеграция в текущий проект

1. Проставить реальные пути к lite/full в `builds-manifest.json`.
2. Сохранить ваш текущий progress bar как есть — orchestrator его не меняет.
3. Убедиться, что игра вызывает:
   - `window.GameLevelReached(level)` на смене уровней;
   - `window.GameOver()` как запасной триггер перехода.
