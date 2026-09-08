// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type SearchProvider = "exa" | "firecrawl";

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ["exa", "firecrawl"];

export function isSearchProvider(value: unknown): value is SearchProvider {
  return value === "exa" || value === "firecrawl";
}

export type SearchKeys = {
  exa: string | null;
  firecrawl: string | null;
};

export type SearchArgs = {
  query: string;
  domain: string | null;
};

export type ProviderRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly keyRejected = false,
  ) {
    super(message);
  }
}
