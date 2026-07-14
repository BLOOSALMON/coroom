// ===== Coroom Service Worker =====
// 목적: 앱 셸(정적 파일)과 Supabase 조회 응답을 캐싱하여,
// 오프라인 상태에서도 마지막으로 성공한 화면을 그대로 보여준다.

const CACHE_VERSION = "v1";
const STATIC_CACHE = `coroom-static-${CACHE_VERSION}`;
const DATA_CACHE = `coroom-data-${CACHE_VERSION}`;

const SUPABASE_HOST = "nhhoffcpgbpmnzyqjjnm.supabase.co";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.allSettled(
        STATIC_ASSETS.map(async (url) => {
          try {
            const request = new Request(url, { cache: "reload" });
            const response = await fetch(request, { mode: url.startsWith("http") ? "no-cors" : "same-origin" });
            await cache.put(url, response);
          } catch (err) {
            // 설치 시점에 네트워크가 불안정해도 나머지 자산 캐싱은 계속 진행
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isSupabaseRestGet(request, url) {
  return (
    request.method === "GET" &&
    url.hostname === SUPABASE_HOST &&
    url.pathname.startsWith("/rest/")
  );
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Promise.reject(new Error("오프라인 상태이며 캐시된 자원이 없습니다."));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 페이지 이동(주소 입력, 새로고침 등): 네트워크 우선, 실패 시 캐시된 앱 셸 반환
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await networkFirst(request, STATIC_CACHE);
        } catch (err) {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match("./index.html")) || Response.error();
        }
      })()
    );
    return;
  }

  // Supabase 조회(GET) 요청: 최신 데이터를 우선 시도하고, 오프라인이면 마지막 응답 재사용
  if (isSupabaseRestGet(request, url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // 같은 출처의 정적 자산 및 CDN 스크립트: 캐시 우선 + 백그라운드 갱신
  if (request.method === "GET" && (url.origin === self.location.origin || url.hostname === "cdn.jsdelivr.net")) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // 그 외(예약 생성/취소 등 쓰기 요청)는 서비스 워커가 관여하지 않음
});
