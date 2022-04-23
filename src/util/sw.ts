/// <reference no-default-lib="true"/>
/// <reference lib="es6" />
/// <reference lib="webworker" />

import { removeQuery } from ".";
import { CacheMessage, CacheMessageKind } from "../cache/cs-cache";

function parseRange(range: string): [number, number?] {
  const r = /^bytes=(\d+)-?(\d+)?/.exec(range);
  return [Number(r[1]), r[2] ? Number(r[2]) : undefined];
}
export async function buildResponse(
  originalResponse: Response,
  range: string
): Promise<Response> {
  if (range) {
    const body = await originalResponse.blob();
    const size = body.size;
    const [start, end] = parseRange(range);

    return new Response(body.slice(start, end ? end + 1 : undefined), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end ? end : size - 1}/${size}`,
        "Content-Type": originalResponse.headers.get("Content-Type"),
      },
    });
  } else {
    return originalResponse;
  }
}

export async function evictCache(
  cache: Cache,
  sizeLimit: number,
  onDelete: (req: Request) => void
): Promise<void> {
  const keys = await cache.keys();
  const toDelete = keys.length - sizeLimit;
  if (toDelete > 0) {
    const deleteList = keys.slice(0, toDelete);
    for (const key of deleteList.reverse()) {
      if (await cache.delete(key)) {
        if (onDelete) onDelete(key);
      }
    }
  }
}

export function cloneRequest(req: Request): Request {
  return new Request(req.url, {
    credentials: "include",
  });
}

export function logFetchError(e: any, url: string) {
  if (e instanceof DOMException && e.name == "AbortError") {
    console.debug(`Caching of ${url} was aborted`);
  } else {
    console.error(`Error caching of ${url}: ${e}`, e);
  }
}

class FetchQueueItem {
  constructor(
    public url: string,
    public abort: AbortController,
    public isDirect: boolean,
    public folderPosition?: number
  ) {}
}

export class AudioCache {
  private queue: FetchQueueItem[] = [];

  constructor(
    private audioCache: string,
    private sizeLimit: number,
    private broadcastMessage: (msg: any) => void
  ) {}

  has(url: string) {
    return this.queue.findIndex((i) => i.url === url) >= 0;
  }

  add(
    url: string,
    abort: AbortController,
    isDirect?: boolean,
    folderPosition?: number
  ) {
    // abort all previous direct request
    if (isDirect)
      this.queue.forEach((i) => {
        if (i.isDirect) i.abort.abort();
      });
    this.queue.push(new FetchQueueItem(url, abort, isDirect, folderPosition));
  }

  delete(url: string) {
    const idx = this.queue.findIndex((i) => i.url === url);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
  }

  abort(pathPrefix: string, keepDirect?: boolean) {
    for (const i of this.queue) {
      if (
        !(keepDirect && i.isDirect) &&
        (!pathPrefix || new URL(i.url).pathname.startsWith(pathPrefix))
      ) {
        i.abort.abort();
      }
    }
  }

  handleRequest(evt: FetchEvent) {
    const rangeHeader = evt.request.headers.get("range");
    evt.respondWith(
      caches
        .open(this.audioCache)
        .then((cache) =>
          cache.match(evt.request).then((resp) => {
            if (resp) {
              console.debug(`SERVING CACHED AUDIO: ${resp.url}`);
              return buildResponse(resp, rangeHeader);
            } else {
              const keyReq = removeQuery(evt.request.url);
              if (this.has(keyReq)) {
                console.debug(
                  `Not caching direct request ${keyReq} as it is already in progress elsewhere`
                );
                return fetch(evt.request);
              } else {
                const posHeader = evt.request.headers.get("X-Folder-Position");
                let folderPosition = posHeader ? Number(posHeader) : undefined;
                if (isNaN(folderPosition)) {
                  folderPosition = undefined;
                }
                const req = cloneRequest(evt.request);
                const abort = new AbortController();

                this.add(keyReq, abort, true, folderPosition);
                req.headers.delete("Range"); // let remove range header so we can cache whole file
                return fetch(req, { signal: abort.signal }).then((resp) => {
                  // if not cached we can put it
                  const keyReq = removeQuery(evt.request.url);
                  cache
                    .put(keyReq, resp.clone())
                    .then(() => {
                      this.broadcastMessage({
                        kind: CacheMessageKind.ActualCached,
                        data: {
                          originalUrl: resp.url,
                          cachedUrl: keyReq,
                        },
                      });
                      evictCache(cache, this.sizeLimit, (req) => {
                        this.broadcastMessage({
                          kind: CacheMessageKind.Deleted,
                          data: {
                            cachedUrl: req.url,
                            originalUrl: req.url,
                          },
                        })
                      })
                    })
                    .catch((e) => logFetchError(e, keyReq))
                    .then(() => this.delete(keyReq));
                  return resp;
                });
              }
            }
          })
        )
        .catch((err) => {
          console.error("SW Error", err);
          return new Response("Service Worker Cache Error", { status: 555 });
        })
    );
  }

  handlePrefetch(evt: ExtendableMessageEvent) {
    const msg: CacheMessage = evt.data;
    console.debug("SW PREFETCH", msg.data.url);
    const keyUrl = removeQuery(msg.data.url);
    let abort: AbortController;

    if (this.has(keyUrl)) {
      this.broadcastMessage({
        kind: CacheMessageKind.Skipped,
        data: {
          cachedUrl: keyUrl,
          originalUrl: msg.data.url,
        },
      });
      return;
    } else {
      abort = new AbortController();
      this.add(keyUrl, abort, false, msg.data.folderPosition);
    }

    evt.waitUntil(
      fetch(msg.data.url, {
        credentials: "include",
        cache: "no-cache",
        signal: abort.signal,
      })
        .then(async (resp) => {
          if (resp.ok) {
            const cache = await self.caches.open(this.audioCache);
            await cache.put(keyUrl, resp);
            this.broadcastMessage({
              kind: CacheMessageKind.PrefetchCached,
              data: {
                cachedUrl: keyUrl,
                originalUrl: resp.url,
              },
            });
            evictCache(cache, this.sizeLimit, (req) => {
              this.broadcastMessage({
                kind: CacheMessageKind.Deleted,
                data: {
                  cachedUrl: req.url,
                  originalUrl: req.url,
                },
              })
            })
            console.debug(
              `SW PREFETCH RESPONSE: ${resp.status} saving as ${keyUrl}`
            );
          } else {
            console.error(
              `Cannot cache audio ${resp.url}: STATUS ${resp.status}`
            );
            this.broadcastMessage({
              kind: CacheMessageKind.PrefetchError,
              data: {
                cachedUrl: keyUrl,
                originalUrl: resp.url,
                error: new Error(`Response status error code: ${resp.status}`),
              },
            });
          }
        })
        .catch((err) =>
          this.broadcastMessage({
            kind: CacheMessageKind.PrefetchError,
            data: {
              cachedUrl: keyUrl,
              originalUrl: msg.data.url,
              error: err,
            },
          })
        )
        .then(() => this.delete(keyUrl))
    );
  }
}

export class NetworkFirstCache {
  private isEnabled = true;

  constructor(private cacheName: string, private sizeLimit = 1000) {}

  async handleRequest(evt: FetchEvent) {
    if (!this.isEnabled) return;
    evt.respondWith(
      fetch(evt.request)
        .then((response) => {
          if (response.status !== 200) {
            console.error(
              `Server returned status ${response.status} for ${evt.request.url}`
            );
            throw response;
          }
          return caches.open(this.cacheName).then((cache) => {
            cache.put(evt.request, response.clone()).then(() => {
              return evictCache(cache, this.sizeLimit, (req) =>
                console.debug(`Deleted ${req.url} from cache ${this.cacheName}`)
              );
            });
            return response;
          });
        })
        .catch((e: any) => {
          const errorResponse = () => {
            if (e instanceof Response) {
              return e;
            } else {
              return new Response("NetworkFirst Cache Error: " + e, {
                status: 555,
              });
            }
          };
          return caches
            .open(this.cacheName)
            .then((cache) => {
              return cache.match(evt.request);
            })
            .then((resp) => {
              if (resp) {
                console.debug("Returning cached response");
                return resp;
              } else {
                return errorResponse();
              }
            })
            .catch(() => {
              return errorResponse();
            });
        })
    );
  }

  enable() {
    this.isEnabled = true;
  }

  disable() {
    this.isEnabled = false;
  }
}
