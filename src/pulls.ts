// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Model downloads in mlx-spy's SQLite database: one row per pull and one per
// file of it. The rows are the resume state: a runner that starts again
// reads which files are done, sizes the .part of the one that was running,
// and continues. Bytes done are written from the runner about once a
// second, so a crash loses at most that.

import type { Database } from "bun:sqlite";
import type { HubFile } from "./hub.ts";

export type PullStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type Pull = {
  id: number;
  repo: string;
  revision: string;
  dir: string;
  status: PullStatus;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  // the file in flight, null between files and when not running
  file: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  // bytes per second over the last seconds; only while running, never stored
  speedBps: number | null;
};

export type PullFile = HubFile & {
  pullId: number;
  done: boolean;
};

type PullRow = {
  id: number;
  repo: string;
  revision: string;
  dir: string;
  status: PullStatus;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  file: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

type FileRow = {
  pullId: number;
  path: string;
  size: number;
  sha256: string | null;
  done: number;
};

const COLUMNS = `id, repo, revision, dir, status,
  bytes_total AS bytesTotal, bytes_done AS bytesDone,
  files_total AS filesTotal, files_done AS filesDone,
  file, error, created_at AS createdAt, updated_at AS updatedAt,
  finished_at AS finishedAt`;

export const PULLS_LISTED = 20;

export class PullStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS pulls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      revision TEXT NOT NULL,
      dir TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_total INTEGER NOT NULL DEFAULT 0,
      bytes_done INTEGER NOT NULL DEFAULT 0,
      files_total INTEGER NOT NULL DEFAULT 0,
      files_done INTEGER NOT NULL DEFAULT 0,
      file TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS pull_files (
      pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pull_id, path)
    )`);
  }

  private toPull(row: PullRow): Pull {
    return { ...row, speedBps: null };
  }

  // Newest first, the last PULLS_LISTED.
  list(): Pull[] {
    const rows = this.db
      .query(`SELECT ${COLUMNS} FROM pulls ORDER BY id DESC LIMIT $n`)
      .all({ n: PULLS_LISTED }) as PullRow[];
    return rows.map((row) => this.toPull(row));
  }

  get(id: number): Pull | null {
    const row = this.db
      .query(`SELECT ${COLUMNS} FROM pulls WHERE id = $id`)
      .get({ id }) as PullRow | null;
    return row ? this.toPull(row) : null;
  }

  // The pull for a repo that is not finished (there is one at most): a
  // second request for the same repo resumes it instead of starting over.
  findOpen(repo: string): Pull | null {
    const row = this.db
      .query(
        `SELECT ${COLUMNS} FROM pulls WHERE repo = $repo AND status <> 'done'
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ repo }) as PullRow | null;
    return row ? this.toPull(row) : null;
  }

  // Pulls that were running or waiting when the process stopped.
  unfinished(): Pull[] {
    const rows = this.db
      .query(
        `SELECT ${COLUMNS} FROM pulls WHERE status IN ('queued', 'running')
         ORDER BY id`,
      )
      .all() as PullRow[];
    return rows.map((row) => this.toPull(row));
  }

  create(repo: string, revision: string, dir: string, files: HubFile[]): Pull {
    const t = this.now();
    const insert = this.db.query(
      `INSERT INTO pulls (repo, revision, dir, status, bytes_total, files_total,
         created_at, updated_at)
       VALUES ($repo, $revision, $dir, 'queued', $bytes, $files, $t, $t)`,
    );
    const insertFile = this.db.query(
      `INSERT INTO pull_files (pull_id, path, size, sha256) VALUES
       ($pullId, $path, $size, $sha256)`,
    );
    const id = this.db.transaction(() => {
      const result = insert.run({
        repo,
        revision,
        dir,
        bytes: files.reduce((n, f) => n + f.size, 0),
        files: files.length,
        t,
      });
      const pullId = Number(result.lastInsertRowid);
      for (const f of files) {
        insertFile.run({
          pullId,
          path: f.path,
          size: f.size,
          sha256: f.sha256,
        });
      }
      return pullId;
    })();
    return this.get(id)!;
  }

  files(pullId: number): PullFile[] {
    const rows = this.db
      .query(
        `SELECT pull_id AS pullId, path, size, sha256, done FROM pull_files
         WHERE pull_id = $pullId ORDER BY rowid`,
      )
      .all({ pullId }) as FileRow[];
    return rows.map((row) => ({ ...row, done: row.done === 1 }));
  }

  setStatus(
    id: number,
    status: PullStatus,
    error: string | null = null,
  ): Pull | null {
    const t = this.now();
    const finished =
      status === "done" || status === "failed" || status === "cancelled";
    this.db
      .query(
        `UPDATE pulls SET status = $status, error = $error, updated_at = $t,
           finished_at = CASE WHEN $finished THEN $t ELSE NULL END,
           file = CASE WHEN $finished THEN NULL ELSE file END
         WHERE id = $id`,
      )
      .run({ id, status, error, t, finished: finished ? 1 : 0 });
    return this.get(id);
  }

  // The bytes so far (the finished files plus the part in flight) and the
  // file in flight.
  progress(id: number, bytesDone: number, file: string | null) {
    this.db
      .query(
        `UPDATE pulls SET bytes_done = $bytesDone, file = $file, updated_at = $t
         WHERE id = $id`,
      )
      .run({ id, bytesDone, file, t: this.now() });
  }

  fileDone(id: number, path: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE pull_files SET done = 1 WHERE pull_id = $id AND path = $path",
        )
        .run({ id, path });
      this.db
        .query(
          `UPDATE pulls SET files_done = (SELECT count(*) FROM pull_files
             WHERE pull_id = $id AND done = 1), updated_at = $t
           WHERE id = $id`,
        )
        .run({ id, t: this.now() });
    })();
  }

  // The file on record as done is not there anymore: it goes again.
  fileUndone(id: number, path: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE pull_files SET done = 0 WHERE pull_id = $id AND path = $path",
        )
        .run({ id, path });
      this.db
        .query(
          `UPDATE pulls SET files_done = (SELECT count(*) FROM pull_files
             WHERE pull_id = $id AND done = 1), updated_at = $t
           WHERE id = $id`,
        )
        .run({ id, t: this.now() });
    })();
  }

  remove(id: number): boolean {
    const result = this.db
      .query("DELETE FROM pulls WHERE id = $id")
      .run({ id });
    return result.changes > 0;
  }
}
