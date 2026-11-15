// GitHub Pages では見出し（ヘッダ）を付けられないので、この service worker が
// Cross-Origin-Opener-Policy と Cross-Origin-Embedder-Policy を付け、
// TransNetV2 の計算を複数のスレッドで動かせるようにする。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  // 同じサイトのファイル（ページ・JS・CSS）は毎回サーバーに新しさを確かめる。
  // 古いファイルと新しいファイルが混ざって画面が動かなくなるのを防ぐ（変わっていなければ 304 で軽い）
  const same = new URL(r.url).origin === self.location.origin && r.method === 'GET';
  const req = !same ? r : r.mode === 'navigate' ? new Request(r.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(r, { cache: 'no-cache' });
  e.respondWith(fetch(req).then(res => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(err => new Response('', { status: 502, statusText: String(err) })));
});
