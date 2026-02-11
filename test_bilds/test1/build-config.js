(function () {
  // Single source of truth for build URLs.
  // Change only these fields when switching versions.
  const DEFAULTS = {
    liteUrl: '/for_developers/2025.09.09_testLite_predprenimatel/',
    fullUrl: '/for_developers/2025.12.25_new_api_serv/',
    fullVersion: '2025.12.25_new_api_serv',

    // Gradual rollout flags for switch behavior.
    enableUnifiedSplash: true,
    enableLevelGate: true,
    enableInPageSwitch: false,

    // Level-based prefetch plan.
    prefetchStartLevel: 3,
    prefetchForceValidateLevel: 5,
    targetSwitchLevel: 6,
    switchTriggerMode: 'level',
    autoSwitchOnTargetLevel: true,
  };

  window.CMP_BUILD_DEFAULTS = DEFAULTS;
  window.CMP_BUILD_CONFIG = Object.assign({}, DEFAULTS);
})();
