// --- Schema Types ------------------------------------------------

export interface SchemaColumnDef {
    /** Column data type. */
    type: typeof TYPES[keyof typeof TYPES];
    /** Field is required. */
    required?: boolean;
    /** Default value or factory function. */
    default?: any | (() => any);
    /** Allow null values. */
    nullable?: boolean;
    /** Is primary key. */
    primaryKey?: boolean;
    /** Auto-increment. */
    autoIncrement?: boolean;
    /** Unique constraint. */
    unique?: boolean;
    /** Minimum string length. */
    minLength?: number;
    /** Maximum string length. */
    maxLength?: number;
    /** Minimum numeric value. */
    min?: number;
    /** Maximum numeric value. */
    max?: number;
    /** Pattern constraint (string). */
    match?: RegExp;
    /** Allowed values (string/enum type). */
    enum?: string[];
    /** Allowed values (set type). */
    values?: string[];
    /** Mass-assignment protection — exclude from bulk writes. */
    guarded?: boolean;
    /** Precision for decimal types. */
    precision?: number;
    /** Scale for decimal types. */
    scale?: number;
    /** Length for fixed-width types (binary, varbinary, char). */
    length?: number;
    /** MySQL: mark column as unsigned. */
    unsigned?: boolean;
    /** MySQL/PG: column charset. */
    charset?: string;
    /** MySQL/PG: column collation. */
    collation?: string;
    /** MySQL/PG: column comment. */
    comment?: string;
    /** PG: array element type for array columns. */
    arrayOf?: string;
    /** PG: foreign key reference. */
    references?: { table: string; column?: string; onDelete?: string; onUpdate?: string };
    /** SQL CHECK constraint expression. */
    check?: string;
    /** Part of a composite primary key. */
    compositeKey?: boolean;
    /** Composite unique constraint group name (or true for default group). */
    compositeUnique?: string | boolean;
}

export const TYPES: {
    readonly STRING: 'string';
    readonly INTEGER: 'integer';
    readonly FLOAT: 'float';
    readonly BOOLEAN: 'boolean';
    readonly DATE: 'date';
    readonly DATETIME: 'datetime';
    readonly JSON: 'json';
    readonly TEXT: 'text';
    readonly BLOB: 'blob';
    readonly UUID: 'uuid';
    // Extended numeric
    readonly BIGINT: 'bigint';
    readonly SMALLINT: 'smallint';
    readonly TINYINT: 'tinyint';
    readonly DECIMAL: 'decimal';
    readonly DOUBLE: 'double';
    readonly REAL: 'real';
    // Extended string/binary
    readonly CHAR: 'char';
    readonly BINARY: 'binary';
    readonly VARBINARY: 'varbinary';
    // Temporal
    readonly TIMESTAMP: 'timestamp';
    readonly TIME: 'time';
    // MySQL-specific
    readonly ENUM: 'enum';
    readonly SET: 'set';
    readonly MEDIUMTEXT: 'mediumtext';
    readonly LONGTEXT: 'longtext';
    readonly MEDIUMBLOB: 'mediumblob';
    readonly LONGBLOB: 'longblob';
    readonly YEAR: 'year';
    // PostgreSQL-specific
    readonly SERIAL: 'serial';
    readonly BIGSERIAL: 'bigserial';
    readonly JSONB: 'jsonb';
    readonly INTERVAL: 'interval';
    readonly INET: 'inet';
    readonly CIDR: 'cidr';
    readonly MACADDR: 'macaddr';
    readonly MONEY: 'money';
    readonly XML: 'xml';
    readonly CITEXT: 'citext';
    readonly ARRAY: 'array';
    // SQLite
    readonly NUMERIC: 'numeric';
};

/**
 * Validate a single value against a column definition.
 * Throws on validation failure.
 */
export function validateValue(value: any, colDef: SchemaColumnDef, colName: string): any;

/**
 * Validate an object against a column schema.
 */
export function validate(
    data: object,
    columns: Record<string, SchemaColumnDef>,
    options?: { partial?: boolean }
): { valid: boolean; errors: string[]; sanitized: object };

/**
 * Validate and normalise a FK action string (CASCADE, SET NULL, etc.).
 * Throws on invalid action.
 */
export function validateFKAction(action: string): string;

/**
 * Validate a CHECK constraint expression for dangerous SQL patterns.
 * Throws on potentially dangerous expressions.
 */
export function validateCheck(expr: string): string;

// --- Query Builder -----------------------------------------------

export class Query {
    constructor(model: typeof Model, adapter: any);

    /** Select specific fields. */
    select(...fields: string[]): Query;
    /** Return distinct rows. */
    distinct(): Query;

    /** Filter by condition. */
    where(field: string, value: any): Query;
    where(field: string, op: string, value: any): Query;
    where(conditions: Record<string, any>): Query;
    /** OR filter. */
    orWhere(field: string, value: any): Query;
    orWhere(field: string, op: string, value: any): Query;
    /** Filter where field IS NULL. */
    whereNull(field: string): Query;
    /** Filter where field IS NOT NULL. */
    whereNotNull(field: string): Query;
    /** Filter where field is in a set of values. */
    whereIn(field: string, values: any[]): Query;
    /** Filter where field is NOT in a set of values. */
    whereNotIn(field: string, values: any[]): Query;
    /** Filter where field is between two values. */
    whereBetween(field: string, low: any, high: any): Query;
    /** Filter where field is NOT between two values. */
    whereNotBetween(field: string, low: any, high: any): Query;
    /** Filter where field matches a LIKE pattern (% and _ wildcards). */
    whereLike(field: string, pattern: string): Query;

    /** Order results. */
    orderBy(field: string, dir?: 'asc' | 'desc'): Query;
    /** Limit result count. */
    limit(n: number): Query;
    /** Offset results. */
    offset(n: number): Query;
    /** Paginate results. */
    page(page: number, perPage?: number): Query;

    /** Group results by fields. */
    groupBy(...fields: string[]): Query;
    /** Having clause for aggregates. */
    having(field: string, op?: string, value?: any): Query;

    /** Inner join. */
    join(table: string, localKey: string, foreignKey: string): Query;
    /** Left join. */
    leftJoin(table: string, localKey: string, foreignKey: string): Query;
    /** Right join. */
    rightJoin(table: string, localKey: string, foreignKey: string): Query;

    /** Include soft-deleted records. */
    withDeleted(): Query;
    /** Apply a named scope from the model's static scopes. */
    scope(name: string, ...args: any[]): Query;

    /** Build the adapter-agnostic query descriptor. */
    build(): object;
    /** Execute the query and return model instances. */
    exec(): Promise<Model[]>;
    /** Execute the query and return the first result. */
    first(): Promise<Model | null>;
    /** Execute a count query. */
    count(): Promise<number>;
    /** Returns true if any matching records exist. */
    exists(): Promise<boolean>;
    /** Returns an array of values for a single column. */
    pluck(field: string): Promise<any[]>;
    /** Returns the sum of a numeric column. */
    sum(field: string): Promise<number>;
    /** Returns the average of a numeric column. */
    avg(field: string): Promise<number>;
    /** Returns the minimum value of a column. */
    min(field: string): Promise<any>;
    /** Returns the maximum value of a column. */
    max(field: string): Promise<any>;

    // -- LINQ-Inspired Methods --------------------------

    /** Alias for limit (LINQ naming). */
    take(n: number): Query;
    /** Alias for offset (LINQ naming). */
    skip(n: number): Query;
    /** Alias for exec — explicitly convert to array. */
    toArray(): Promise<Model[]>;
    /** Shorthand for orderBy(field, 'desc'). */
    orderByDesc(field: string): Query;
    /** Execute and return the last result. */
    last(): Promise<Model | null>;

    /** Conditionally apply query logic when condition is truthy. */
    when(condition: any, fn: (query: Query) => void): Query;
    /** Conditionally apply query logic when condition is falsy. */
    unless(condition: any, fn: (query: Query) => void): Query;
    /** Inspect the query without breaking the chain (for debugging/logging). */
    tap(fn: (query: Query) => void): Query;

    /** Process results in batches. Calls fn(batch, batchIndex) for each chunk. */
    chunk(size: number, fn: (batch: Model[], index: number) => void | Promise<void>): Promise<void>;
    /** Execute and iterate each result with a callback. */
    each(fn: (item: Model, index: number) => void | Promise<void>): Promise<void>;
    /** Execute, transform results with a mapper, and return the mapped array. */
    map<T>(fn: (item: Model, index: number) => T): Promise<T[]>;
    /** Execute, filter results with a predicate, and return matches. */
    filter(fn: (item: Model, index: number) => boolean): Promise<Model[]>;
    /** Execute and reduce results to a single value. */
    reduce<T>(fn: (acc: T, item: Model, index: number) => T, initial: T): Promise<T>;

    /** Rich pagination with metadata: { data, total, page, perPage, pages, hasNext, hasPrev }. */
    paginate(page: number, perPage?: number): Promise<PaginatedResult>;

    /** Inject a raw WHERE clause for SQL adapters (ignored by memory/mongo). */
    whereRaw(sql: string, ...params: any[]): Query;

    /** Thenable support — `await query`. */
    then<TResult1 = Model[], TResult2 = never>(
        onfulfilled?: ((value: Model[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2>;
    catch<TResult = never>(
        onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
    ): Promise<Model[] | TResult>;
}

// --- Pagination Result -------------------------------------------

export interface PaginatedResult {
    data: Model[];
    total: number;
    page: number;
    perPage: number;
    pages: number;
    hasNext: boolean;
    hasPrev: boolean;
}

// --- Model -------------------------------------------------------

export interface ModelHooks {
    beforeCreate?: (data: object) => void | Promise<void>;
    afterCreate?: (instance: Model) => void | Promise<void>;
    beforeUpdate?: (instance: Model, data: object) => void | Promise<void>;
    afterUpdate?: (instance: Model) => void | Promise<void>;
    beforeDelete?: (instance: Model) => void | Promise<void>;
    afterDelete?: (instance: Model) => void | Promise<void>;
}

export interface FindOrCreateResult {
    instance: Model;
    created: boolean;
}

export class Model {
    /** Table name (override in subclass). */
    static table: string;
    /** Column schema (override in subclass). */
    static schema: Record<string, SchemaColumnDef>;
    /** Enable automatic timestamps (createdAt, updatedAt). */
    static timestamps: boolean;
    /** Enable soft deletes (deletedAt). */
    static softDelete: boolean;
    /** Lifecycle hooks. */
    static hooks: ModelHooks;
    /** Fields excluded from toJSON() output. */
    static hidden: string[];
    /** Reusable named query conditions: { name: (query, ...args) => query }. */
    static scopes: Record<string, (query: Query, ...args: any[]) => Query>;

    constructor(data?: object);

    /** Whether the instance has been persisted. */
    _persisted: boolean;

    /** Save the instance (insert or update dirty fields). */
    save(): Promise<Model>;
    /** Update fields on the instance. */
    update(data: object): Promise<Model>;
    /** Delete the instance (soft or hard). */
    delete(): Promise<void>;
    /** Restore a soft-deleted instance. */
    restore(): Promise<Model>;
    /** Reload the instance from the database. */
    reload(): Promise<Model>;
    /** Return a plain object representation (respects static hidden). */
    toJSON(): object;
    /** Load a named relationship. */
    load(relationName: string): Promise<Model | Model[] | null>;
    /** Increment a numeric field by amount (default 1). */
    increment(field: string, by?: number): Promise<Model>;
    /** Decrement a numeric field by amount (default 1). */
    decrement(field: string, by?: number): Promise<Model>;

    /** Create a new record. */
    static create(data: object): Promise<Model>;
    /** Create multiple records. */
    static createMany(dataArray: object[]): Promise<Model[]>;
    /** Find records matching conditions. */
    static find(conditions?: object): Promise<Model[]>;
    /** Find a single record matching conditions. */
    static findOne(conditions: object): Promise<Model | null>;
    /** Find a record by primary key. */
    static findById(id: any): Promise<Model | null>;
    /** Find or create a record. */
    static findOrCreate(conditions: object, defaults?: object): Promise<FindOrCreateResult>;
    /** Update records matching conditions. */
    static updateWhere(conditions: object, data: object): Promise<number>;
    /** Delete records matching conditions. */
    static deleteWhere(conditions: object): Promise<number>;
    /** Count records matching conditions. */
    static count(conditions?: object): Promise<number>;
    /** Check if any records match the conditions. */
    static exists(conditions?: object): Promise<boolean>;
    /** Insert or update a record. Returns { instance, created }. */
    static upsert(conditions: object, data: object): Promise<FindOrCreateResult>;
    /** Start a fluent query builder with a named scope applied. */
    static scope(name: string, ...args: any[]): Query;
    /** Start a fluent query builder. */
    static query(): Query;

    // -- LINQ-Inspired Static Shortcuts ------------------

    /** Find the first record matching optional conditions. */
    static first(conditions?: object): Promise<Model | null>;
    /** Find the last record matching optional conditions. */
    static last(conditions?: object): Promise<Model | null>;
    /** Get all records (alias for find). */
    static all(conditions?: object): Promise<Model[]>;
    /** Rich pagination with metadata. */
    static paginate(page: number, perPage?: number, conditions?: object): Promise<PaginatedResult>;
    /** Process all matching records in batches. */
    static chunk(size: number, fn: (batch: Model[], index: number) => void | Promise<void>, conditions?: object): Promise<void>;
    /** Get a random record. */
    static random(conditions?: object): Promise<Model | null>;
    /** Pluck values for a single column. */
    static pluck(field: string, conditions?: object): Promise<any[]>;

    /** Define a has-many relationship. */
    static hasMany(RelatedModel: typeof Model, foreignKey: string, localKey?: string): void;
    /** Define a has-one relationship. */
    static hasOne(RelatedModel: typeof Model, foreignKey: string, localKey?: string): void;
    /** Define a belongs-to relationship. */
    static belongsTo(RelatedModel: typeof Model, foreignKey: string, otherKey?: string): void;
    /** Define a many-to-many relationship through a junction table. */
    static belongsToMany(RelatedModel: typeof Model, options: {
        through: string;
        foreignKey: string;
        otherKey: string;
        localKey?: string;
        relatedKey?: string;
    }): void;

    /** Create/sync the table in the database. */
    static sync(): Promise<void>;
    /** Drop the table from the database. */
    static drop(): Promise<void>;

    /** Allow index access for model fields. */
    [key: string]: any;
}

// --- SQLite Options ----------------------------------------------

export interface SqlitePragmas {
    journal_mode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'MEMORY' | 'OFF';
    foreign_keys?: 'ON' | 'OFF';
    busy_timeout?: string;
    synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
    cache_size?: string;
    temp_store?: 'DEFAULT' | 'FILE' | 'MEMORY';
    mmap_size?: string;
    page_size?: string;
    auto_vacuum?: 'NONE' | 'FULL' | 'INCREMENTAL';
    secure_delete?: 'ON' | 'OFF';
    wal_autocheckpoint?: string;
    locking_mode?: 'NORMAL' | 'EXCLUSIVE';
    [key: string]: string | undefined;
}

export interface SqliteOptions {
    filename?: string;
    readonly?: boolean;
    fileMustExist?: boolean;
    verbose?: boolean;
    createDir?: boolean;
    pragmas?: SqlitePragmas;
}

export interface MySqlOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionLimit?: number;
    waitForConnections?: boolean;
    queueLimit?: number;
    connectTimeout?: number;
    charset?: string;
    timezone?: string;
    ssl?: string | object;
    multipleStatements?: boolean;
    decimalNumbers?: boolean;
    [key: string]: any;
}

export interface PostgresOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionString?: string;
    ssl?: boolean | object;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    application_name?: string;
    statement_timeout?: number;
    [key: string]: any;
}

export interface MongoOptions {
    url?: string;
    database?: string;
    maxPoolSize?: number;
    minPoolSize?: number;
    connectTimeoutMS?: number;
    socketTimeoutMS?: number;
    serverSelectionTimeoutMS?: number;
    retryWrites?: boolean;
    retryReads?: boolean;
    authSource?: string;
    replicaSet?: string;
    clientOptions?: object;
    [key: string]: any;
}

export interface JsonOptions {
    dir: string;
    pretty?: boolean;
    flushInterval?: number;
    autoFlush?: boolean;
}

export type AdapterOptions = SqliteOptions | MySqlOptions | PostgresOptions | MongoOptions | JsonOptions | object;

// --- SQLite Adapter ----------------------------------------------

export interface SqliteAdapter {
    /** Read a single PRAGMA value. */
    pragma(key: string): any;
    /** Force a WAL checkpoint. */
    checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): { busy: number; log: number; checkpointed: number };
    /** Run PRAGMA integrity_check. Returns 'ok' or a problem description. */
    integrity(): string;
    /** Rebuild the database file, reclaiming free pages. */
    vacuum(): void;
    /** Get the database file size in bytes (0 for in-memory). */
    fileSize(): number;
    /** List all user-created table names. */
    tables(): string[];
    /** Run a raw SQL SELECT query. */
    raw(sql: string, ...params: any[]): any[];
    /** Close the database connection. */
    close(): void;
}

// --- MySQL Adapter -----------------------------------------------

export interface MySqlAdapter {
    /** List all tables in the current database. */
    tables(): Promise<string[]>;
    /** Get column info for a table. */
    columns(table: string): Promise<Array<{ Field: string; Type: string; Null: string; Key: string; Default: any; Extra: string }>>;
    /** Get total database size in bytes. */
    databaseSize(): Promise<number>;
    /** Get connection pool status. */
    poolStatus(): { total: number; idle: number; used: number; queued: number };
    /** Get MySQL server version string. */
    version(): Promise<string>;
    /** Ping the server. Returns true if healthy. */
    ping(): Promise<boolean>;
    /** Execute a raw write/DDL statement. Returns affected rows and insert ID. */
    exec(sql: string, ...params: any[]): Promise<{ affectedRows: number; insertId: number }>;
    /** Run a raw SQL SELECT query. */
    raw(sql: string, ...params: any[]): Promise<any[]>;
    /** Run a function inside a transaction. */
    transaction(fn: (connection: any) => Promise<void>): Promise<void>;
    /** Close the connection pool. */
    close(): Promise<void>;
}

// --- PostgreSQL Adapter ------------------------------------------

export interface PostgresAdapter {
    /** List all tables in a schema (default: 'public'). */
    tables(schema?: string): Promise<string[]>;
    /** Get column info for a table. */
    columns(table: string, schema?: string): Promise<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>;
    /** Get total database size in bytes. */
    databaseSize(): Promise<number>;
    /** Get total size of a table including indexes, in bytes. */
    tableSize(table: string): Promise<number>;
    /** Get connection pool status. */
    poolStatus(): { total: number; idle: number; waiting: number };
    /** Get PostgreSQL server version string. */
    version(): Promise<string>;
    /** Ping the server. Returns true if healthy. */
    ping(): Promise<boolean>;
    /** Execute a raw write/DDL statement. Returns row count. */
    exec(sql: string, ...params: any[]): Promise<{ rowCount: number }>;
    /** Subscribe to PostgreSQL LISTEN/NOTIFY channel. Returns an unlisten function. */
    listen(channel: string, callback: (msg: { channel: string; payload?: string }) => void): Promise<() => Promise<void>>;
    /** Run a raw SQL SELECT query. */
    raw(sql: string, ...params: any[]): Promise<any[]>;
    /** Run a function inside a transaction. */
    transaction(fn: (client: any) => Promise<void>): Promise<void>;
    /** Close the connection pool. */
    close(): Promise<void>;
}

// --- MongoDB Adapter ---------------------------------------------

export interface MongoAdapter {
    /** List all collections in the database. */
    collections(): Promise<string[]>;
    /** Get database-level stats. */
    stats(): Promise<{ collections: number; objects: number; dataSize: number; storageSize: number; indexes: number; indexSize: number }>;
    /** Get stats for a specific collection. */
    collectionStats(name: string): Promise<{ count: number; size: number; avgObjSize: number; storageSize: number; nindexes: number }>;
    /** Create an index on a collection. */
    createIndex(collection: string, keys: Record<string, 1 | -1 | 'text'>, options?: { unique?: boolean; sparse?: boolean; [key: string]: any }): Promise<string>;
    /** List all indexes on a collection. */
    indexes(collection: string): Promise<any[]>;
    /** Drop an index by name. */
    dropIndex(collection: string, indexName: string): Promise<void>;
    /** Ping the MongoDB server. Returns true if healthy. */
    ping(): Promise<boolean>;
    /** Get the MongoDB server version. */
    version(): Promise<string>;
    /** Whether the client is currently connected. */
    readonly isConnected: boolean;
    /** Run a raw MongoDB command. */
    raw(command: object): Promise<any>;
    /** Run a function inside a transaction (requires replica set). */
    transaction(fn: (session: any) => Promise<void>): Promise<void>;
    /** Close the connection. */
    close(): Promise<void>;
}

// --- Memory Adapter ----------------------------------------------

export interface MemoryAdapter {
    /** List all registered table names. */
    tables(): string[];
    /** Count all rows across all tables. */
    totalRows(): number;
    /** Get memory stats. */
    stats(): { tables: number; totalRows: number; estimatedBytes: number };
    /** Export all data as a plain object. */
    toJSON(): Record<string, any[]>;
    /** Import data from a plain object. */
    fromJSON(data: Record<string, any[]>): void;
    /** Deep-clone the entire database into a new MemoryAdapter. */
    clone(): MemoryAdapter;
    /** Delete all rows from all tables. */
    clear(): void;
    /** Run a raw query (memory adapter supports select/insert/update/delete descriptors). */
    execute(query: object): any[];
    /** Close (no-op for memory). */
    close(): void;
}

// --- JSON Adapter ------------------------------------------------

export interface JsonAdapter extends MemoryAdapter {
    /** The resolved directory path where JSON files are stored. */
    readonly directory: string;
    /** Get total size of all JSON files in bytes. */
    fileSize(): number;
    /** Whether there are unflushed writes. */
    readonly hasPendingWrites: boolean;
    /** Re-serialize and save a table's JSON file. */
    compact(table: string): void;
    /** Copy all JSON files to a target directory. */
    backup(destDir: string): void;
    /** Immediately write all pending changes to disk. */
    flush(): Promise<void>;
}

// --- Database ----------------------------------------------------

export type AdapterType = 'memory' | 'json' | 'sqlite' | 'mysql' | 'postgres' | 'mongo';

export class Database {
    /** The underlying adapter instance. */
    adapter: any;

    constructor(adapter: any);

    /**
     * Connect to a database using the specified adapter type.
     * Validates credentials for network adapters (mysql, postgres, mongo).
     */
    static connect(type: 'sqlite', options?: SqliteOptions): Database & { adapter: SqliteAdapter };
    static connect(type: 'mysql', options?: MySqlOptions): Database & { adapter: MySqlAdapter };
    static connect(type: 'postgres', options?: PostgresOptions): Database & { adapter: PostgresAdapter };
    static connect(type: 'mongo', options?: MongoOptions): Database & { adapter: MongoAdapter };
    static connect(type: 'memory', options?: object): Database & { adapter: MemoryAdapter };
    static connect(type: 'json', options?: JsonOptions): Database & { adapter: JsonAdapter };
    static connect(type: AdapterType, options?: AdapterOptions): Database;

    /**
     * Register a Model class with this database connection.
     */
    register(ModelClass: typeof Model): Database;

    /**
     * Register multiple Model classes.
     */
    registerAll(...models: Array<typeof Model>): Database;

    /**
     * Sync all registered models (create tables).
     */
    sync(): Promise<void>;

    /**
     * Drop all registered model tables.
     */
    drop(): Promise<void>;

    /**
     * Close the database connection.
     */
    close(): Promise<void>;

    /**
     * Get a registered model by name.
     */
    model(name: string): typeof Model | undefined;

    /**
     * Run a function inside a transaction (begin/commit/rollback if supported).
     */
    transaction(fn: () => Promise<void>): Promise<void>;

    // -- DDL / Migration Methods --------------------------------

    /** Add a column to an existing table. */
    addColumn(table: string, column: string, definition: SchemaColumnDef): Promise<void>;
    /** Drop a column from a table. */
    dropColumn(table: string, column: string): Promise<void>;
    /** Rename a column. */
    renameColumn(table: string, oldName: string, newName: string): Promise<void>;
    /** Rename a table. */
    renameTable(oldName: string, newName: string): Promise<void>;
    /** Create an index on a table. */
    createIndex(table: string, columns: string | string[], options?: { name?: string; unique?: boolean }): Promise<void>;
    /** Drop an index. */
    dropIndex(table: string, name: string): Promise<void>;
    /** Check if a table exists. */
    hasTable(table: string): Promise<boolean>;
    /** Check if a column exists on a table. */
    hasColumn(table: string, column: string): Promise<boolean>;
    /** Get detailed column info for a table. */
    describeTable(table: string): Promise<Array<any>>;
    /** Add a foreign key constraint. */
    addForeignKey(table: string, column: string, refTable: string, refColumn: string, options?: { onDelete?: string; onUpdate?: string; name?: string }): Promise<void>;
    /** Drop a foreign key constraint. */
    dropForeignKey(table: string, constraintName: string): Promise<void>;
}
