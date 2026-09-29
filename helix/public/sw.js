/*
 * The service worker. It exists to make Helix installable, and it is
 * deliberately close to doing nothing.
 *
 * A browser will only offer to install a page that has one of these with a
 * fetch handler. The tempting next step — cache everything and serve it back
 * — is wrong here, and badly so:
 *
 *   Helix is served from your own machine. There is no round trip across the
 *   internet to save, so a cache buys nothing but staleness: you would edit a
 *   file, reload, and get yesterday's version with no way to tell.
 *
 *   Everything interesting on this screen is a live answer — the vault, a
 *   reply, what is configured. A cached one is a wrong one.
 *
 * So: the network answers every request. The shell is kept only as a fallback
 * for when the server is not there, which turns "this site can't be reached"
 * into a screen that says the vault could not be read — the same thing Helix
 * says for any other failure to reach it.
 *
 * Bump SHELL when the shell's files change, so the fallback copy does not
 * outlive the version it belonged to.
 */

const SHELL = 'helix-shell-v2';

/*
 * Only the files that make up the screen itself. No API route is listed, and
 * none is ever cached — a stale /galaxy or /settings would have Helix
 * confidently reporting a vault that has since changed.
 */
const SHELL_FILES = [
  '/',
  '/index.html',
  '/helix.css',
  '/galaxy.js',
  '/app.js',
  '/console.js',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // addAll fails the whole install if any one file 404s, which is the point:
  // a half-populated fallback is worse than none.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  // Take over on the next load rather than making the person close every tab.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that is not a plain read of the page is none of this worker's
  // business: POSTs, the audio of a spoken line, an OAuth round trip.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Refresh the fallback copy from what the server just said, so the
        // offline screen is the current one rather than the one from install.
        if (response.ok && SHELL_FILES.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit !== undefined) return hit;

          /*
           * Nothing cached for this one, and the server is not there.
           *
           * Only a page navigation gets the shell back. Anything else has to
           * fail the way it would with no worker at all — the first version
           * of this handed the shell to every miss, so with the server down
           * /galaxy answered 200 with a page of HTML and the screen reported
           * a vault it had not read. A failure the app can see is worth more
           * than a response it cannot trust.
           */
          if (request.mode === 'navigate') return caches.match('/index.html');
          throw new Error('offline');
        })
      )
  );
});
