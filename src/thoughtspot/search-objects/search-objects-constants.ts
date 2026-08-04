// Tuning constants for the search_objects tool, kept in one place.

// Default page size when the caller omits `limit`.
export const DEFAULT_SEARCH_LIMIT = 10;

// Eureka request param: cap on pinboard vizzes expanded per result.
export const MAX_PINBOARD_VIZ_COUNT = 5;

// Post-filter pagination bounds: a page cap AND a wall-clock budget so a sparse
// filter can't fan out into unbounded/too-slow upstream calls.
export const MAX_PAGES = 20;
export const POST_FILTERING_TIME_LIMIT = 15_000; // ms
