(function () {
  var RESET_MARKER_KEY = "next-master-sw-reset-at";
  var RESET_QUERY_PARAM = "__nm_sw_reset";

  function rememberReset() {
    try {
      window.sessionStorage.setItem(RESET_MARKER_KEY, String(Date.now()));
    } catch (_error) {
      // Best effort only.
    }
  }

  function hasResetMarker() {
    try {
      if (new URL(window.location.href).searchParams.get(RESET_QUERY_PARAM) === "1") return true;
      var raw = window.sessionStorage.getItem(RESET_MARKER_KEY);
      return Boolean(raw && Date.now() - Number(raw) < 60000);
    } catch (_error) {
      return false;
    }
  }

  function clearCaches() {
    if (!("caches" in window)) return Promise.resolve();
    return window.caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (name) {
            return window.caches.delete(name);
          }),
        );
      })
      .catch(function () {
        return undefined;
      });
  }

  function unregisterServiceWorkers() {
    if (!("serviceWorker" in navigator)) return Promise.resolve();
    return navigator.serviceWorker
      .getRegistrations()
      .then(function (registrations) {
        return Promise.all(
          registrations.map(function (registration) {
            return registration.unregister().catch(function () {
              return undefined;
            });
          }),
        );
      })
      .catch(function () {
        return undefined;
      });
  }

  Promise.all([clearCaches(), unregisterServiceWorkers()]).then(function () {
    if (hasResetMarker()) return;
    rememberReset();
    var nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(RESET_QUERY_PARAM, "1");
    window.location.replace(nextUrl.toString());
  });
})();
