// Paging limits for list_analysts. The backend accepts record_size 1..500 and record_offset
// 0..10_000 on POST /convex/spots/public/search; offsets past the cap are rejected upstream.
export const LIST_ANALYSTS_DEFAULT_PAGE_SIZE = 50;
export const LIST_ANALYSTS_MAX_PAGE_SIZE = 500;
export const LIST_ANALYSTS_MAX_OFFSET = 10_000;
