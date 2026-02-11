  (function() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'new.css';
    document.head.appendChild(link);
    // Переменные для управления прогрессом
    var fakeProgress = 0;
    var realProgress = 0;
    var unityLoaded = false;
    var animationId = null;
    // Этапы прогресса: [целевой %, время в секундах]
    var stages = [
      [40, 5],   // 0-40% за 5 секунд
      [60, 5],   // 40-60% за 5 секунд
      [65, 5],   // 60-65% за 5 секунд
      [85, 5],   // 65-85% за 5 секунд
      [90, 10],  // 85-90% за 10 секунд
      [91, 1],   // 90-91% за 1 секунду
      [92, 2],   // 91-92% за 2 секунды
      [93, 3],   // 92-93% за 3 секунды
      [94, 4],   // 93-94% за 4 секунды
      [97, 3],   // 94-97% за 3 секунды
      [98, 5],   // 97-98% за 5 секунд
      [99, 7],   // 98-99% за 7 секунд
      [99, Infinity]  // 99% до завершения загрузки
    ];
    // Функция для обновления прогресс-бара
    function updateProgressBar() {
      // Всегда показываем максимум из реального и фейкового прогресса
      var displayProgress = Math.max(fakeProgress, realProgress);
      
      // Если игра загрузилась, показываем 100%
      if (unityLoaded) {
        displayProgress = 100;
      }
      
      // Обновляем отображение прогресс-бара
      if (progressBarFull) {
        progressBarFull.style.width = displayProgress + '%';
        let progressSpan = progressBarFull.querySelector('span');
        if (!progressSpan) {
          progressSpan = document.createElement('span');
          progressBarFull.appendChild(progressSpan);
        }
        progressSpan.textContent = displayProgress.toFixed() + '%';
      }
    }
    // Функция анимации фейкового прогресса
    function animateFakeProgress(timestamp) {
      if (unityLoaded) return;
      
      if (!animationId) {
        animationId = timestamp;
      }
      
      var elapsed = (timestamp - animationId) / 1000; // в секундах
      var totalDuration = 0;
      var startValue = 0;
      var currentStage = 0;
      
      // Определяем текущий этап
      for (var i = 0; i < stages.length; i++) {
        var stage = stages[i];
        var stageTarget = stage[0];
        var stageDuration = stage[1];
        
        if (i === stages.length - 1 || elapsed <= totalDuration + stageDuration) {
          currentStage = i;
          break;
        }
        
        totalDuration += stageDuration;
        startValue = stageTarget;
      }
      
      var currentStageData = stages[currentStage];
      var stageTarget = currentStageData[0];
      var stageDuration = currentStageData[1];
      
      if (currentStage === stages.length - 1) {
        // Последний этап - просто устанавливаем 99%
        fakeProgress = 99;
      } else {
        var stageElapsed = elapsed - totalDuration;
        var stageProgress = Math.min(stageElapsed / stageDuration, 1);
        fakeProgress = startValue + (stageTarget - startValue) * stageProgress;
      }
      
      updateProgressBar();
      
      if (!unityLoaded) {
        requestAnimationFrame(animateFakeProgress);
      }
    }
    // Перехватываем обработчик прогресса Unity
    var originalOnProgress = config.onProgress;
    config.onProgress = function(progress) {
      realProgress = progress * 100;
      
      if (progress === 1) {
        unityLoaded = true;
        fakeProgress = 100;
        updateProgressBar();
        
        // Скрываем полосу загрузки с задержкой
        setTimeout(function() {
          if (loadingBar) {
            loadingBar.style.display = 'none';
          }
        }, 500);
      } else {
        updateProgressBar();
      }
      
      // Вызываем оригинальный обработчик, если он есть
      if (originalOnProgress) {
        originalOnProgress(progress);
      }
    };
    // Запускаем анимацию фейкового прогресса
    requestAnimationFrame(animateFakeProgress);
  })();

