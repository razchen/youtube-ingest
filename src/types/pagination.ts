export type PaginationRequest = {
  page: number;
  limit: number;
};

export type PaginationResponse<T> = {
  items: T[];
  page: number;
  total: number;
  limit: number;
};
