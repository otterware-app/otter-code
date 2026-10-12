/**
 * `<stateDir>/suite.sqlite`: every Otterware module's tables. It sits beside
 * the shared `statev2.sqlite` instead of inside it, so an Otterware server and
 * a plain Otter Code server can run on the same data home interchangeably
 * (one at a time, see `StateDirGuard.ts`) without schema drift in the main DB.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

export const SUITE_DATABASE_FILENAME = "suite.sqlite";

/**
 * The suite database's client, under its own tag so it never collides with the
 * main `SqlClient.SqlClient` (statev2.sqlite) in the server's layer graph.
 */
export class SuiteSqlClient extends Context.Service<SuiteSqlClient, SqlClient.SqlClient>()(
  "t3/suite/SuiteDatabase/SuiteSqlClient",
) {}

const configure = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    return sql;
  });

const layerFromClient = <E, R>(client: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.effect(SuiteSqlClient, Effect.flatMap(SqlClient.SqlClient, configure)).pipe(
    Layer.provide(client),
  );

export const layerFromPath = (dbPath: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      return layerFromClient(
        NodeSqliteClient.layer({
          filename: dbPath,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "t3code-server",
          },
        }),
      );
    }),
  );

/** Opens `<stateDir>/suite.sqlite`. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerFromPath(path.join(config.stateDir, SUITE_DATABASE_FILENAME));
  }),
);

export const layerMemory = layerFromClient(NodeSqliteClient.layer({ filename: ":memory:" }));

/**
 * Provides the suite database AS `SqlClient.SqlClient`, for module subgraphs
 * written against a plain SqlClient. Provide it locally to the module's own
 * layers (`Layer.provide(SuiteDatabase.layerSqlClient)`), never globally: the
 * main graph's `SqlClient` is statev2.sqlite.
 */
export const layerSqlClient = Layer.effect(SqlClient.SqlClient, SuiteSqlClient);
