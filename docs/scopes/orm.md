# ORM

> Database, Model, Query, migrations, seeds, search, geo, tenancy, audit.

## Install

```bash
npm install @zero-server/orm
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Full-featured ORM with seven adapters (memory, JSON file, SQLite, MySQL, PostgreSQL, MongoDB, Redis) plus migrations, seeders, query caching, read replicas, full-text search, geo queries, multi-tenancy, audit logging, schema snapshots, query profiling, views, stored procedures/functions/triggers, and a plugin manager.

## Usage

```js
const { Database, Model, TYPES } = require('@zero-server/orm')
```

## Public surface

`@zero-server/orm` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `Database` |
| `Model` |
| `TYPES` |
| `Query` |
| `validateFKAction` |
| `validateCheck` |
| `Migrator` |
| `defineMigration` |
| `QueryCache` |
| `Seeder` |
| `SeederRunner` |
| `Factory` |
| `Fake` |
| `QueryProfiler` |
| `ReplicaManager` |
| `DatabaseView` |
| `FullTextSearch` |
| `GeoQuery` |
| `EARTH_RADIUS_KM` |
| `EARTH_RADIUS_MI` |
| `TenantManager` |
| `AuditLog` |
| `PluginManager` |
| `StoredProcedure` |
| `StoredFunction` |
| `TriggerManager` |
| `buildSnapshot` |
| `loadSnapshot` |
| `saveSnapshot` |
| `diffSnapshots` |
| `hasNoChanges` |
| `generateMigrationCode` |
| `discoverModels` |
| `SNAPSHOT_FILE` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/orm`](../../packages/orm)
