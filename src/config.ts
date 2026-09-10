// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The models the user added from the chat's config page, per hosted
// provider, in mlx-spy's SQLite file. A row always came from the
// provider's catalog once (the page checks an id before it can be added);
// a refresh updates its name, window and prices and marks the rows the
// catalog no longer lists, without dropping them.

import type { Database } from "bun:sqlite";
import type { CatalogModel } from "./engine/openrouter.ts";
import { isProviderId, type ProviderId } from "./engine/types.ts";

export type RemoteModel = {
  provider: ProviderId;
  id: string;
  name: string;
  contextLength: number | null;
  // USD per million tokens; null when the catalog did not say
  promptPrice: number | null;
  completionPrice: number | null;
  tools: boolean;
  reasoning: boolean;
  addedAt: number;
  // the last refresh that found it in the catalog
  checkedAt: number;
  // the last refresh did not list it
  missing: boolean;
};

type Row = {
  provider: string;
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  tools: number;
  reasoning: number;
  addedAt: number;
  checkedAt: number;
  missing: number;
};

const SELECT = `SELECT provider, id, name, context_length AS contextLength,
  prompt_price AS promptPrice, completion_price AS completionPrice, tools,
  reasoning, added_at AS addedAt, checked_at AS checkedAt, missing
  FROM remote_models`;

export class ConfigStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.run(`CREATE TABLE IF NOT EXISTS remote_models (
      provider TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      context_length INTEGER,
      prompt_price REAL,
      completion_price REAL,
      tools INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL,
      checked_at INTEGER NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, id)
    )`);
  }

  private toModel(row: Row): RemoteModel {
    return {
      provider: isProviderId(row.provider) ? row.provider : "openrouter",
      id: row.id,
      name: row.name,
      contextLength: row.contextLength,
      promptPrice: row.promptPrice,
      completionPrice: row.completionPrice,
      tools: row.tools === 1,
      reasoning: row.reasoning === 1,
      addedAt: row.addedAt,
      checkedAt: row.checkedAt,
      missing: row.missing === 1,
    };
  }

  list(provider: ProviderId): RemoteModel[] {
    const rows = this.db
      .query(`${SELECT} WHERE provider = $provider ORDER BY added_at, id`)
      .all({ provider }) as Row[];
    return rows.map((row) => this.toModel(row));
  }

  get(provider: ProviderId, id: string): RemoteModel | null {
    const row = this.db
      .query(`${SELECT} WHERE provider = $provider AND id = $id`)
      .get({ provider, id }) as Row | null;
    return row ? this.toModel(row) : null;
  }

  // false when the id is already there
  add(provider: ProviderId, model: CatalogModel): boolean {
    const now = this.now();
    const result = this.db
      .query(`INSERT OR IGNORE INTO remote_models (provider, id, name,
        context_length, prompt_price, completion_price, tools, reasoning,
        added_at, checked_at, missing)
        VALUES ($provider, $id, $name, $contextLength, $promptPrice,
          $completionPrice, $tools, $reasoning, $now, $now, 0)`)
      .run({
        provider,
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        promptPrice: model.promptPrice,
        completionPrice: model.completionPrice,
        tools: model.tools ? 1 : 0,
        reasoning: model.reasoning ? 1 : 0,
        now,
      });
    return result.changes > 0;
  }

  remove(provider: ProviderId, id: string): boolean {
    return (
      this.db
        .query(
          "DELETE FROM remote_models WHERE provider = $provider AND id = $id",
        )
        .run({ provider, id }).changes > 0
    );
  }

  // every saved row against a fresh catalog: found rows take its name,
  // window, prices and flags; the others are marked missing and kept
  refresh(provider: ProviderId, catalog: Map<string, CatalogModel>): number {
    const now = this.now();
    const update = this.db.query(`UPDATE remote_models SET name = $name,
      context_length = $contextLength, prompt_price = $promptPrice,
      completion_price = $completionPrice, tools = $tools,
      reasoning = $reasoning, checked_at = $now, missing = 0
      WHERE provider = $provider AND id = $id`);
    const miss = this.db.query(`UPDATE remote_models SET missing = 1
      WHERE provider = $provider AND id = $id`);
    let found = 0;
    this.db.transaction(() => {
      for (const row of this.list(provider)) {
        const model = catalog.get(row.id);
        if (!model) {
          miss.run({ provider, id: row.id });
          continue;
        }
        found++;
        update.run({
          provider,
          id: row.id,
          name: model.name,
          contextLength: model.contextLength,
          promptPrice: model.promptPrice,
          completionPrice: model.completionPrice,
          tools: model.tools ? 1 : 0,
          reasoning: model.reasoning ? 1 : 0,
          now,
        });
      }
    })();
    return found;
  }
}
