// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const workers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps writes moving past a 48 MiB WAL while a reader retains its snapshot", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-burst-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkpointWorker = workers.at(-1)!;
    yield* sql`CREATE TABLE burst_probe(id INTEGER PRIMARY KEY, payload BLOB)`;
    yield* sql`INSERT INTO burst_probe VALUES (1, NULL)`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);

    yield* sql.withTransaction(
      sql`INSERT INTO burst_probe VALUES (2, zeroblob(${48 * 1024 * 1024}))`,
    );
    const state = yield* Effect.callback<{
      readonly log: number;
      readonly checkpointed: number;
      readonly blocked: boolean;
    }>((resume) => {
      const onMessage = (message: {
        readonly type?: string;
        readonly log?: number;
        readonly checkpointed?: number;
        readonly blocked?: boolean;
      }) => {
        if (
          message.type === "checkpoint" &&
          typeof message.log === "number" &&
          message.log > 10_000 &&
          typeof message.checkpointed === "number" &&
          typeof message.blocked === "boolean"
        ) {
          checkpointWorker.off("message", onMessage);
          resume(
            Effect.succeed({
              log: message.log,
              checkpointed: message.checkpointed,
              blocked: message.blocked,
            }),
          );
        }
      };
      checkpointWorker.on("message", onMessage);
      checkpointWorker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      checkpointWorker.postMessage("barrier");
      return Effect.sync(() => checkpointWorker.off("message", onMessage));
    });
    assert.isBelow(state.checkpointed, state.log);
    assert.isFalse(state.blocked);

    yield* sql.withTransaction(sql`INSERT INTO burst_probe VALUES (3, NULL)`);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(persistence),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const ownT3Home = Effect.fn("SqliteTest.ownT3Home")(function* () {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
});

const migrateTo = Effect.fn("SqliteTest.migrateTo")(function* (toMigrationInclusive?: number) {
  const { dbPath } = yield* ServerConfig.ServerConfig;
  yield* runMigrations({ toMigrationInclusive }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
  );
});

const databaseSnapshot = Effect.fn("SqliteTest.databaseSnapshot")(function* () {
  const { dbPath } = yield* ServerConfig.ServerConfig;
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
    (db) =>
      Effect.sync(() => ({
        schema: db
          .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
        migrations: db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
        data: db.prepare("SELECT * FROM guard_probe ORDER BY id").all(),
      })),
    (db) => Effect.sync(() => db.close()),
  );
});

const layerT3Home = ServerConfig.layerTest(process.cwd(), { prefix: "t3-sqlite-cli-" });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CLI database ownership", (it) => {
  it.effect("refuses CLI auth before changing a running server's older schema or data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        yield* migrateTo(Math.max(...migrationManifest.map(([id]) => id)) - 1);
        const { dbPath } = yield* ServerConfig.ServerConfig;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE guard_probe(id INTEGER PRIMARY KEY, payload TEXT)`;
          yield* sql`INSERT INTO guard_probe VALUES (1, 'retained')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* ownT3Home();
        const before = yield* databaseSnapshot();
        const opened = yield* Effect.void.pipe(
          Effect.provide(EnvironmentAuth.layerRuntime),
          Effect.result,
        );
        assert.deepEqual(yield* databaseSnapshot(), before);
        assert.equal(opened._tag, "Failure");
        if (opened._tag === "Failure") assert.equal(opened.failure._tag, "ServerOwnsDatabaseError");
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect("allows current-schema CLI auth and persistence while the server owns the home", () =>
    Effect.gen(function* () {
      yield* migrateTo();
      yield* ownT3Home();
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        assert.deepEqual(yield* auth.listSessions(), []);
      }).pipe(Effect.provide(EnvironmentAuth.layerRuntime));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly id: number;
        }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
        assert.equal(rows[0]?.id, Math.max(...migrationManifest.map(([id]) => id)));
      }).pipe(Effect.provide(SqlitePersistence.layerCliConfig));
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect("migrates after release, ignores stale runtime metadata and permits a new owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        yield* migrateTo(Math.max(...migrationManifest.map(([id]) => id)) - 1);
        const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
        yield* Effect.scoped(ownT3Home());
        yield* fs.writeFileString(
          serverRuntimeStatePath,
          JSON.stringify({
            version: 1,
            pid: -1,
            ownerId: "released-owner",
            port: 1,
            origin: "http://127.0.0.1:1",
            startedAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly id: number;
          }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
          assert.equal(rows[0]?.id, Math.max(...migrationManifest.map(([id]) => id)));
        }).pipe(Effect.provide(SqlitePersistence.layerCliConfig));
        yield* Effect.scoped(ownT3Home());
        yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerCliConfig));
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect(
    "releases a migration lock on failure and interruption without claiming runtime state",
    () =>
      Effect.gen(function* () {
        const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const contents = JSON.stringify({
          version: 1,
          pid: -1,
          ownerId: "stale-owner",
          port: 1,
          origin: "http://127.0.0.1:1",
          startedAt: "2026-01-01T00:00:00.000Z",
        });
        yield* fs.writeFileString(serverRuntimeStatePath, contents);
        yield* migrateTo(Math.max(...migrationManifest.map(([id]) => id)) - 1);
        const { dbPath } = yield* ServerConfig.ServerConfig;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE scheduled_tasks RENAME TO migration_probe_tasks`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const failed = yield* Effect.void.pipe(
          Effect.provide(SqlitePersistence.layerCliConfig),
          Effect.result,
        );
        assert.equal(failed._tag, "Failure");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly id: number;
          }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
          assert.equal(rows[0]?.id, Math.max(...migrationManifest.map(([id]) => id)) - 1);
          yield* sql`ALTER TABLE migration_probe_tasks RENAME TO scheduled_tasks`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerCliConfig));
        const acquired = yield* Deferred.make<void>();
        const holder = yield* Effect.scoped(
          ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath).pipe(
            Effect.andThen(Deferred.succeed(acquired, undefined)),
            Effect.andThen(Effect.never),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(acquired);
        yield* Fiber.interrupt(holder);
        yield* Effect.scoped(ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath));
        assert.equal(yield* fs.readFileString(serverRuntimeStatePath), contents);
      }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );
});
