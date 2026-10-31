'use strict';

const SEATMAP_CACHE_MS = Math.max(
  0,
  Number(process.env.SEATMAP_CACHE_MS) || 0
);

const mapCache = new Map();

function invalidateSeatMap() {
  mapCache.clear();
}

function getSeatMap(eventId) {
  const hit = mapCache.get(eventId);

  if (
    SEATMAP_CACHE_MS > 0 &&
    hit &&
    Date.now() - hit.at < SEATMAP_CACHE_MS
  ) {
    return hit.promise;
  }

  return null;
}

function setSeatMap(eventId, promise) {
  if (SEATMAP_CACHE_MS <= 0) return;

  const entry = { at: Date.now(), promise };
  mapCache.set(eventId, entry);

  promise.catch(() => {
    if (mapCache.get(eventId) === entry) {
      mapCache.delete(eventId);
    }
  });
}

module.exports = {
  getSeatMap,
  setSeatMap,
  invalidateSeatMap,
};
