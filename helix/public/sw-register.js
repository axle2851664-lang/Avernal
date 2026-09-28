/*
 * Register the service worker, which is what makes Helix installable.
 *
 * Its own file rather than an inline block, because index.html asserts it has
 * no inline script — everything the page does is a file you can read.
 *
 * Registration is best-effort in every direction. A browser without service
 * workers, a page served over plain HTTP, a registration that throws: all of
 * them cost the install prompt and none of them cost the app, which works
 * exactly the same either way.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      // Worth saying once. The usual cause is an insecure origin — a bare
      // LAN address rather than localhost or HTTPS — which is the same thing
      // that stops the microphone opening.
      console.warn('Helix will not be installable here:', err.message);
    });
  });
})();
