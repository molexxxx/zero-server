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
    /** Composite index group name (or true for default group). */
    compositeIndex?: string | boolean;
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

    // -- Performance / Scalability (Phase 2) -----------------

    /** Eager-count relationships without loading records. Adds `RelationName_count` fields. */
    withCount(...relations: string[]): Query;
    /** Force this query to run against a read replica if configured. */
    onReplica(): Query;
    /** Get the query execution plan from the adapter. */
    explain(options?: { analyze?: boolean; buffers?: boolean; format?: string }): Promise<any>;

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

    /** Define a polymorphic one-to-one relationship. */
    static morphOne(RelatedModel: typeof Model, morphName: string, localKey?: string): void;
    /** Define a polymorphic one-to-many relationship. */
    static morphMany(RelatedModel: typeof Model, morphName: string, localKey?: string): void;
    /** Define a has-many-through relationship (distant relation via intermediate model). */
    static hasManyThrough(
        RelatedModel: typeof Model,
        ThroughModel: typeof Model,
        firstKey: string,
        secondKey: string,
        localKey?: string,
        secondLocalKey?: string,
    ): void;
    /** Define self-referential parent/children relationships. */
    static selfReferential(options: {
        foreignKey: string;
        parentName?: string;
        childrenName?: string;
    }): void;
    /** Build a tree structure from self-referential records. */
    static tree(options?: {
        foreignKey?: string;
        childrenKey?: string;
        rootValue?: any;
    }): Promise<any[]>;

    /** Get all ancestors of this instance in a self-referential tree. */
    ancestors(foreignKey?: string): Promise<Model[]>;
    /** Get all descendants of this instance (breadth-first). */
    descendants(foreignKey?: string): Promise<Model[]>;

    // -- Computed & Virtual Columns (Phase 3) -----------------

    /** Computed column definitions: { name: (instance) => value }. */
    static computed: Record<string, (instance: Model) => any>;
    /** Attribute casting definitions: { field: castType | { get, set } }. */
    static casts: Record<string, string | { get?: (value: any) => any; set?: (value: any) => any }>;
    /** Accessor transforms applied on read: { field: (value, instance) => transformedValue }. */
    static accessors: Record<string, (value: any, instance: Model) => any>;
    /** Mutator transforms applied on write: { field: (value, instance) => transformedValue }. */
    static mutators: Record<string, (value: any, instance: Model) => any>;

    /** Get an attribute value with accessor/cast applied. */
    getAttribute(key: string): any;
    /** Set an attribute value with mutator/cast applied. */
    setAttribute(key: string, value: any): Model;

    // -- Model Events (Phase 3) -------------------------------

    /** Listen for a model event. */
    static on(event: string, listener: (...args: any[]) => void): typeof Model;
    /** Listen for a model event once. */
    static once(event: string, listener: (...args: any[]) => void): typeof Model;
    /** Remove a model event listener. */
    static off(event: string, listener: (...args: any[]) => void): typeof Model;
    /** Remove all listeners for an event, or all listeners entirely. */
    static removeAllListeners(event?: string): typeof Model;

    // -- Observers (Phase 3) ----------------------------------

    /** Register an observer object with lifecycle methods. */
    static observe(observer: Partial<ModelObserver>): typeof Model;
    /** Unregister an observer. */
    static unobserve(observer: Partial<ModelObserver>): typeof Model;

    /** Create/sync the table in the database. */
    static sync(): Promise<void>;
    /** Drop the table from the database. */
    static drop(): Promise<void>;

    /** Allow index access for model fields. */
    [key: string]: any;
}

// --- Model Observer --------------------------------------------------

export interface ModelObserver {
    creating?: (data: object) => void | Promise<void>;
    created?: (instance: Model) => void | Promise<void>;
    updating?: (data: object) => void | Promise<void>;
    updated?: (instance: Model) => void | Promise<void>;
    deleting?: (instance: Model) => void | Promise<void>;
    deleted?: (instance: Model) => void | Promise<void>;
}

// --- DatabaseView ----------------------------------------------------

export interface DatabaseViewOptions {
    /** Query builder instance defining the view's SELECT. */
    query?: Query;
    /** Raw SQL for the view definition (SQL adapters only). */
    sql?: string;
    /** Model class the view is based on. */
    model?: typeof Model;
    /** Column schema for the view (optional; inferred from model if omitted). */
    schema?: Record<string, SchemaColumnDef>;
    /** Whether to create a materialized view (PostgreSQL only). */
    materialized?: boolean;
}

export class DatabaseView {
    /** View name. */
    readonly name: string;

    constructor(name: string, options: DatabaseViewOptions);

    /** Create the view in the database. */
    create(db: Database): Promise<DatabaseView>;
    /** Drop the view from the database. */
    drop(db?: Database): Promise<void>;
    /** Refresh a materialized view (PostgreSQL only). */
    refresh(db?: Database): Promise<void>;
    /** Check whether the view exists. */
    exists(db?: Database): Promise<boolean>;
    /** Query all records from the view. */
    all(): Promise<any[]>;
    /** Find records matching conditions. */
    find(conditions?: object): Promise<any[]>;
    /** Find a single record. */
    findOne(conditions?: object): Promise<any | null>;
    /** Count records in the view. */
    count(conditions?: object): Promise<number>;
    /** Start a fluent query against the view. */
    query(): Query;
}

// --- FullTextSearch --------------------------------------------------

export interface FullTextSearchOptions {
    /** Column names to include in the search index. */
    fields: string[];
    /** Weight map for fields (e.g. { title: 'A', body: 'B' }). */
    weights?: Record<string, string | number>;
    /** Language for stemming/tokenisation (default: 'english'). */
    language?: string;
    /** Custom index name. */
    indexName?: string;
}

export interface SearchOptions {
    /** Include relevance ranking in results. */
    rank?: boolean;
    /** Maximum number of results. */
    limit?: number;
    /** Offset for pagination. */
    offset?: number;
    /** Additional WHERE conditions. */
    where?: object;
    /** Custom order ('rank' or a column name). */
    orderBy?: string;
}

export interface SuggestOptions {
    /** Max suggestions (default: 10). */
    limit?: number;
    /** Specific field to suggest from. */
    field?: string;
}

export class FullTextSearch {
    constructor(ModelClass: typeof Model, options: FullTextSearchOptions);

    /** Create the full-text search index. */
    createIndex(db: Database): Promise<FullTextSearch>;
    /** Drop the full-text search index. */
    dropIndex(db?: Database): Promise<void>;
    /** Perform a full-text search. */
    search(query: string, options?: SearchOptions): Promise<any[]>;
    /** Search and return model instances. */
    searchModels(query: string, options?: SearchOptions): Promise<Model[]>;
    /** Count matching search results. */
    count(query: string, options?: Pick<SearchOptions, 'where'>): Promise<number>;
    /** Build search suggestions (autocomplete). */
    suggest(prefix: string, options?: SuggestOptions): Promise<string[]>;
}

// --- GeoQuery --------------------------------------------------------

/** Earth's radius in kilometres. */
export const EARTH_RADIUS_KM: 6371;
/** Earth's radius in miles. */
export const EARTH_RADIUS_MI: 3959;

export interface GeoQueryOptions {
    /** Column name for latitude. */
    latField: string;
    /** Column name for longitude. */
    lngField: string;
    /** Distance unit: 'km' or 'mi' (default: 'km'). */
    unit?: 'km' | 'mi';
}

export interface NearOptions {
    /** Maximum distance (in configured unit). */
    radius?: number;
    /** Maximum number of results. */
    limit?: number;
    /** Skip N results. */
    offset?: number;
    /** Additional WHERE conditions. */
    where?: object;
    /** Override distance unit. */
    unit?: 'km' | 'mi';
    /** Add _distance property to results (default: true). */
    includeDistance?: boolean;
}

export interface WithinBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

export interface GeoJSONPoint {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
}

export interface GeoJSONFeature {
    type: 'Feature';
    geometry: GeoJSONPoint;
    properties: Record<string, any>;
}

export interface GeoJSONFeatureCollection {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}

export class GeoQuery {
    constructor(ModelClass: typeof Model, options: GeoQueryOptions);

    /** Find records near a geographic point. */
    near(lat: number, lng: number, options?: NearOptions): Promise<any[]>;
    /** Find records within a bounding box. */
    within(bounds: WithinBounds, options?: { limit?: number; where?: object }): Promise<any[]>;
    /** Calculate distance between two points. */
    distance(lat1: number, lng1: number, lat2: number, lng2: number, unit?: 'km' | 'mi'): number;
    /** Calculate Haversine distance between two points. */
    static haversine(lat1: number, lng1: number, lat2: number, lng2: number, unit?: 'km' | 'mi'): number;
    /** Convert a record to GeoJSON Feature. */
    toGeoJSON(record: any, options?: { properties?: string[] }): GeoJSONFeature;
    /** Convert multiple records to a GeoJSON FeatureCollection. */
    toGeoJSONCollection(records: any[], options?: { properties?: string[] }): GeoJSONFeatureCollection;
    /** Create a model data object from a GeoJSON Feature. */
    fromGeoJSON(feature: GeoJSONFeature): object;
    /** Check if a point is within a given radius of a center point. */
    isWithinRadius(lat: number, lng: number, centerLat: number, centerLng: number, radius: number, unit?: 'km' | 'mi'): boolean;
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

export interface RedisOptions {
    /** Redis connection URL: redis://user:pass@host:6379/0. */
    url?: string;
    /** Redis server hostname. Must be a non-empty string. */
    host?: string;
    /** Redis server port. Must be between 1 and 65535. */
    port?: number;
    /** Redis password (AUTH). */
    password?: string;
    /** Redis database index. Must be between 0 and 15. */
    db?: number;
    /** Key prefix for namespacing all keys. */
    prefix?: string;
    /** Max connection retry attempts. */
    maxRetries?: number;
    /** Defer connection until first operation. */
    lazyConnect?: boolean;
    /** Connection timeout in ms. Must be non-negative. */
    connectTimeout?: number;
    /** TLS options for secure connections. */
    tls?: object;
    [key: string]: any;
}

export type AdapterOptions = SqliteOptions | MySqlOptions | PostgresOptions | MongoOptions | JsonOptions | RedisOptions | object;

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

// --- Redis Adapter -----------------------------------------------

export interface RedisAdapter {
    /** Get a value by key. Auto-parses JSON. */
    get(key: string): Promise<any>;
    /** Set a key/value pair. Optional TTL in seconds (must be >= 0). */
    set(key: string, value: any, ttl?: number): Promise<void>;
    /** Delete a key. */
    del(key: string): Promise<number>;
    /** Check if a key exists. */
    exists(key: string): Promise<boolean>;
    /** Set a TTL on an existing key. Seconds must be >= 0. */
    expire(key: string, seconds: number): Promise<boolean>;
    /** Get remaining TTL in seconds (-1 = no expiry, -2 = missing). */
    ttl(key: string): Promise<number>;
    /** Increment a numeric key by 1. Returns the new value. */
    incr(key: string): Promise<number>;
    /** Decrement a numeric key by 1. Returns the new value. */
    decr(key: string): Promise<number>;
    /** Set a hash field. */
    hset(key: string, field: string, value: any): Promise<number>;
    /** Get a hash field value. */
    hget(key: string, field: string): Promise<string | null>;
    /** Get all fields and values in a hash. */
    hgetall(key: string): Promise<Record<string, string>>;
    /** Delete a hash field. */
    hdel(key: string, field: string): Promise<number>;
    /** Append values to a list (right). */
    rpush(key: string, ...values: any[]): Promise<number>;
    /** Prepend values to a list (left). */
    lpush(key: string, ...values: any[]): Promise<number>;
    /** Get a range of list elements. */
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    /** Remove and return the last list element. */
    rpop(key: string): Promise<string | null>;
    /** Remove and return the first list element. */
    lpop(key: string): Promise<string | null>;
    /** Get the length of a list. */
    llen(key: string): Promise<number>;
    /** Add members to a set. */
    sadd(key: string, ...members: any[]): Promise<number>;
    /** Get all members of a set. */
    smembers(key: string): Promise<string[]>;
    /** Check if a value is in a set. */
    sismember(key: string, member: any): Promise<boolean>;
    /** Remove a member from a set. */
    srem(key: string, member: any): Promise<number>;
    /** Get the number of members in a set. */
    scard(key: string): Promise<number>;
    /** Add a member to a sorted set with a score. */
    zadd(key: string, score: number, member: any): Promise<number>;
    /** Get members in a sorted set by index range. */
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    /** Get members by score range. */
    zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
    /** Remove a member from a sorted set. */
    zrem(key: string, member: any): Promise<number>;
    /** Get the number of members in a sorted set. */
    zcard(key: string): Promise<number>;
    /** Subscribe to a pub/sub channel. callback must be a function. Returns an unsubscribe function. */
    subscribe(channel: string, callback: (message: string) => void): Promise<() => Promise<void>>;
    /** Publish a message to a channel. Returns number of receivers. */
    publish(channel: string, message: string): Promise<number>;
    /** Create a pipeline for batching commands. */
    pipeline(): any;
    /** Execute a raw Redis command. Command must be a non-empty string. */
    raw(command: string, ...args: any[]): Promise<any>;
    /** Ping the Redis server. Returns 'PONG' if healthy. */
    ping(): Promise<string>;
    /** Get Redis server info. Optional section filter. */
    info(section?: string): Promise<string>;
    /** Get the number of keys in the current database. */
    dbsize(): Promise<number>;
    /** Close the Redis connection. */
    close(): Promise<void>;
}

// --- Database ----------------------------------------------------

export type AdapterType = 'memory' | 'json' | 'sqlite' | 'mysql' | 'postgres' | 'mongo' | 'redis';

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
    static connect(type: 'redis', options?: RedisOptions): Database & { adapter: RedisAdapter };
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

    /** Ping the database to check connectivity. */
    ping(): Promise<boolean>;
    /** Retry a function with exponential backoff. */
    retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;

    // -- Performance & Scalability (Phase 2) -----------------

    /** Enable query profiling on this database instance. */
    enableProfiling(options?: QueryProfilerOptions): QueryProfiler;
    /** The attached profiler (null if not enabled). */
    readonly profiler: QueryProfiler | null;
    /** The attached replica manager (null if not configured). */
    readonly replicas: ReplicaManager | null;

    /**
     * Connect with read replicas.
     * @param type       - Adapter type for all connections.
     * @param primaryOpts - Connection options for the primary.
     * @param replicaConfigs - Array of connection options for each replica.
     * @param options    - ReplicaManager options.
     */
    static connectWithReplicas(
        type: AdapterType,
        primaryOpts: AdapterOptions,
        replicaConfigs: AdapterOptions[],
        options?: ReplicaManagerOptions,
    ): Database;
}

export interface RetryOptions {
    retries?: number;
    delay?: number;
    maxDelay?: number;
    factor?: number;
    onRetry?: (error: Error, attempt: number) => void;
}

// --- Migrator -------------------------------------------------------

export interface MigrationDefinition {
    /** Unique migration name. Only letters, digits, underscores, hyphens, and dots are allowed. */
    name: string;
    up: (db: Database) => Promise<void>;
    down: (db: Database) => Promise<void>;
}

export interface MigrateResult {
    migrated: string[];
    batch: number;
}

export interface RollbackResult {
    rolledBack: string[];
    batch: number;
}

export interface MigrationStatus {
    executed: Array<{ name: string; batch: number; executedAt: string }>;
    pending: string[];
    lastBatch: number;
}

export class Migrator {
    constructor(db: Database, options?: { table?: string });

    /** Add a migration definition. */
    add(migration: MigrationDefinition): Migrator;
    /** Add multiple migration definitions. */
    addAll(migrations: MigrationDefinition[]): Migrator;
    /** Run all pending migrations. */
    migrate(): Promise<MigrateResult>;
    /** Rollback the last batch. */
    rollback(): Promise<RollbackResult>;
    /** Rollback all migrations. */
    rollbackAll(): Promise<{ rolledBack: string[] }>;
    /** Rollback all, then re-migrate. */
    reset(): Promise<MigrateResult & { rolledBack: string[] }>;
    /** Drop everything and re-migrate. */
    fresh(): Promise<MigrateResult>;
    /** Get current migration status. */
    status(): Promise<MigrationStatus>;
    /** Check if there are pending migrations. */
    hasPending(): Promise<boolean>;
    /** List registered migration names. */
    list(): string[];
}

/** Helper to create a migration definition. */
export function defineMigration(
    name: string,
    up: (db: Database) => Promise<void>,
    down: (db: Database) => Promise<void>,
): MigrationDefinition;

// --- QueryCache -----------------------------------------------------

export interface QueryCacheOptions {
    maxEntries?: number;
    defaultTTL?: number;
    prefix?: string;
    redis?: any;
}

export interface CacheStats {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    maxEntries: number;
}

export class QueryCache {
    constructor(options?: QueryCacheOptions);

    /** Generate a cache key from a query descriptor. */
    static keyFromDescriptor(descriptor: Record<string, any>): string;
    /** Get a cached value. */
    get(key: string): any;
    /** Set a cached value. */
    set(key: string, value: any, ttl?: number): void;
    /** Delete a cached entry. */
    delete(key: string): boolean;
    /** Check if a key exists and is not expired. */
    has(key: string): boolean;
    /** Invalidate all entries matching a table name. */
    invalidate(table: string): number;
    /** Clear the entire cache. */
    flush(): number;
    /** Get hit/miss statistics. */
    stats(): CacheStats;
    /** Remove expired entries. */
    prune(): number;
    /** Get or compute and cache a value. */
    remember<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T>;
    /** Wrap a query execution with caching. */
    wrap<T>(descriptor: Record<string, any>, executor: () => Promise<T>, ttl?: number): Promise<T>;
}

// --- Seeder ---------------------------------------------------------

/** Base Seeder class. Extend to create seeders. */
export class Seeder {
    /** Override this method to define seeding logic. */
    run(db: Database): Promise<void>;
}

export class SeederRunner {
    constructor(db: Database);

    /** Run one or more seeder classes. */
    run(...seeders: Array<(new () => Seeder) | Seeder>): Promise<string[]>;
    /** Run a single seeder. */
    call(SeederClass: new () => Seeder): Promise<void>;
    /** Clear all data, then run seeders. */
    fresh(...seeders: Array<(new () => Seeder) | Seeder>): Promise<string[]>;
}

// --- Factory --------------------------------------------------------

export class Factory<T extends typeof Model = typeof Model> {
    constructor(ModelClass: T);

    /** Define default field generators. */
    define(definition: Record<string, any | ((index: number) => any)>): Factory<T>;
    /** Set how many records to create. */
    count(n: number): Factory<T>;
    /** Define a named state variation. */
    state(name: string, overrides: Record<string, any>): Factory<T>;
    /** Apply a named state to the next create/make. */
    withState(name: string): Factory<T>;
    /** Register an after-create callback. */
    afterCreating(fn: (record: any, index: number) => Promise<void>): Factory<T>;
    /** Build records without persisting. */
    make(overrides?: Record<string, any>): any | any[];
    /** Create and persist records. */
    create(overrides?: Record<string, any>): Promise<any | any[]>;
}

// --- Fake -----------------------------------------------------------

export interface FakeNameOptions {
    sex?: 'male' | 'female';
    locale?: string;
    unique?: boolean;
}

export interface FakeFullNameOptions extends FakeNameOptions {
    prefix?: boolean;
    middle?: boolean;
    suffix?: boolean;
    firstName?: string;
    lastName?: string;
}

export interface FakePhoneOptions {
    /** ISO country code (default: 'US'). */
    countryCode?: string;
    /** Format style (default: 'human'). */
    format?: 'human' | 'national' | 'international';
    unique?: boolean;
}

export interface FakeEmailOptions {
    firstName?: string;
    lastName?: string;
    /** Force a specific provider domain. */
    provider?: string;
    /** Use only safe example./test. domains. */
    safe?: boolean;
    locale?: string;
    unique?: boolean;
}

export interface FakeUsernameOptions {
    firstName?: string;
    lastName?: string;
    /** Separator style between name parts. */
    style?: 'dot' | 'underscore' | 'none' | 'random';
    /** Append a numeric suffix (default: true). */
    numbers?: boolean;
    locale?: string;
    unique?: boolean;
}

export interface FakeNumericStringOptions {
    /** Allow leading zeros (default: true). */
    leadingZeros?: boolean;
    /** Grouping separator character (e.g. '-' for credit-card style). */
    separator?: string;
    /** Width of each separated group. */
    groupSize?: number;
}

export interface FakePasswordOptions {
    length?: number;
    uppercase?: boolean;
    lowercase?: boolean;
    digits?: boolean;
    special?: boolean;
    prefix?: string;
}

export interface FakePriceOptions {
    min?: number;
    max?: number;
    symbol?: string;
}

export interface FakeAddressOptions {
    countryCode?: string;
    /** 'string' (default) or 'object' to return address parts. */
    format?: 'string' | 'object';
}

export interface FakeAddressObject {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
}

export interface FakeMacOptions {
    separator?: ':' | '-' | '.';
    realisticOUI?: boolean;
}

export interface FakeUrlOptions {
    protocol?: string;
    appendSlash?: boolean;
    /** Suppress the word path segment. */
    noPath?: boolean;
}

export interface FakeIpOptions {
    network?: 'any' | 'private-a' | 'private-b' | 'private-c' | 'loopback';
}

export interface FakeUniqueOptions {
    /** Namespace key for deduplication tracking. */
    key?: string;
    maxAttempts?: number;
}

export class Fake {
    // -- RNG / Seeding ------------------------------------------------
    /** Set a deterministic seed (pass null to reset). */
    static seed(value?: number | string | null): number | null;
    /** Return the active seed, or null if using Math.random. */
    static getSeed(): number | null;
    /**
     * Generate a unique value by calling fn() until an unseen result is
     * returned for the given namespace key.
     */
    static unique<T>(fn: () => T, options?: FakeUniqueOptions): T;
    /** Clear uniqueness tracking for a key, or all keys if omitted. */
    static resetUnique(key?: string): void;
    /** Count how many unique values have been generated for a key. */
    static uniqueCount(key: string): number;

    // -- Names --------------------------------------------------------
    static firstName(options?: FakeNameOptions): string;
    static lastName(options?: Pick<FakeNameOptions, 'locale' | 'unique'>): string;
    /** Default (no options) returns exactly "First Last". */
    static fullName(options?: FakeFullNameOptions): string;
    static middleName(options?: FakeNameOptions): string;
    static namePrefix(options?: Pick<FakeNameOptions, 'sex'>): string;
    static nameSuffix(): string;
    /** List of supported locale codes. */
    static locales(): string[];

    // -- Phone --------------------------------------------------------
    static phone(options?: FakePhoneOptions): string;
    /** All supported phone country codes. */
    static phoneCodes(): string[];

    // -- Internet / Email ---------------------------------------------
    static email(options?: FakeEmailOptions): string;
    static username(options?: FakeUsernameOptions): string;
    static domainName(options?: { tld?: string }): string;
    static url(options?: FakeUrlOptions): string;
    static ip(options?: FakeIpOptions): string;
    static ipv6(): string;
    static mac(options?: FakeMacOptions): string;
    static port(options?: { range?: 'all' | 'registered' | 'dynamic' }): number;
    static httpMethod(options?: { methods?: string[] }): string;
    static userAgent(): string;
    static password(options?: FakePasswordOptions): string;

    // -- Numbers ------------------------------------------------------
    static uuid(): string;
    static integer(min?: number, max?: number): number;
    static float(min?: number, max?: number, decimals?: number): number;
    static boolean(): boolean;
    /** Fixed-length numeric string (e.g. ZIP codes, PINs, credit card numbers). */
    static numericString(length?: number, options?: FakeNumericStringOptions): string;
    /** Random alphanumeric string. */
    static alphanumeric(length?: number, options?: { uppercase?: boolean }): string;
    /** Random alphabetic string. */
    static alpha(length?: number, options?: { uppercase?: boolean }): string;

    // -- Dates --------------------------------------------------------
    static date(start?: Date, end?: Date): Date;
    static dateString(start?: Date, end?: Date): string;
    static datePast(options?: { years?: number }): Date;
    static dateFuture(options?: { years?: number }): Date;

    // -- Text ---------------------------------------------------------
    static paragraph(sentences?: number): string;
    static sentence(wordCount?: number): string;
    static word(options?: { type?: 'lorem' | 'adjective' | 'noun' | 'verb' }): string;
    static words(n?: number): string;
    static hackerPhrase(): string;
    static slug(wordCount?: number): string;
    static hashtag(): string;

    // -- Person -------------------------------------------------------
    static jobTitle(options?: { full?: boolean }): string;
    static jobArea(): string;
    static jobType(): string;
    static jobDescriptor(): string;
    static bio(options?: { style?: 'short' | 'medium' | 'long' }): string;
    static zodiacSign(): string;
    static gender(options?: { binary?: boolean }): string;
    static bloodType(): string;

    // -- Location -----------------------------------------------------
    static city(options?: { country?: string }): string;
    static country(options?: { codeOnly?: boolean; full?: boolean }): string | { name: string; code: string };
    static state(options?: { abbr?: boolean; full?: boolean }): string | { name: string; abbr: string };
    static zipCode(options?: { countryCode?: string }): string;
    static latitude(options?: { min?: number; max?: number; decimals?: number }): number;
    static longitude(options?: { min?: number; max?: number; decimals?: number }): number;
    static coordinates(): { latitude: number; longitude: number };
    static timezone(): string;
    static streetName(): string;
    static address(options?: FakeAddressOptions): string | FakeAddressObject;

    // -- Commerce -----------------------------------------------------
    static productName(options?: { withMaterial?: boolean }): string;
    static category(): string;
    static department(): string;
    static company(options?: { suffix?: boolean }): string;
    static price(options?: FakePriceOptions): string;
    static industry(): string;
    static catchPhrase(): string;

    // -- Colour -------------------------------------------------------
    static color(): string;
    static rgb(options?: { format?: 'css' | 'array' | 'object' }): string | number[] | { r: number; g: number; b: number };
    static hsl(options?: { format?: 'css' | 'array' | 'object' }): string | number[] | { h: number; s: number; l: number };

    // -- Helpers ------------------------------------------------------
    static pick<T>(arr: T[]): T;
    static pickMany<T>(arr: T[], n: number): T[];
    static shuffle<T>(arr: T[]): T[];
    static enumValue<T>(values: T[]): T;
    static json(): { key: string; value: string; count: number; active: boolean };
}

// --- QueryProfiler --------------------------------------------------

export interface QueryProfilerOptions {
    /** Enable/disable profiling (default: true). */
    enabled?: boolean;
    /** Duration (ms) above which a query is "slow" (default: 100). */
    slowThreshold?: number;
    /** Maximum recorded query entries (default: 1000). */
    maxHistory?: number;
    /** Callback on slow query. */
    onSlow?: (entry: ProfiledQuery) => void;
    /** Minimum rapid same-table SELECTs to flag N+1 (default: 5). */
    n1Threshold?: number;
    /** Time window (ms) for N+1 detection (default: 100). */
    n1Window?: number;
    /** Callback on N+1 detection. */
    onN1?: (info: N1Detection) => void;
    /** Maximum N+1 detection history entries (default: 100). */
    maxN1History?: number;
}

export interface ProfiledQuery {
    table: string;
    action: string;
    duration: number;
    timestamp: number;
}

export interface N1Detection {
    table: string;
    count: number;
    timestamp: number;
    message: string;
}

export interface ProfilerMetrics {
    totalQueries: number;
    totalTime: number;
    avgLatency: number;
    queriesPerSecond: number;
    slowQueries: number;
    n1Detections: number;
}

export class QueryProfiler {
    constructor(options?: QueryProfilerOptions);

    /** Whether profiling is currently enabled. */
    get enabled(): boolean;
    set enabled(value: boolean);

    /** Record a query execution. */
    record(entry: { table: string; action: string; duration: number }): void;
    /** Get aggregate profiling metrics. */
    metrics(): ProfilerMetrics;
    /** Get all slow queries from history. */
    slowQueries(): ProfiledQuery[];
    /** Get all N+1 detections. */
    n1Detections(): N1Detection[];
    /** Get filtered query history. */
    getQueries(options?: { table?: string; action?: string; minDuration?: number }): ProfiledQuery[];
    /** Reset all profiling state. */
    reset(): void;
}

// --- ReplicaManager -------------------------------------------------

export interface ReplicaManagerOptions {
    /** Selection strategy: 'round-robin' | 'random' (default: 'round-robin'). */
    strategy?: 'round-robin' | 'random';
    /** Read from primary after a write for stickyWindow ms (default: true). */
    stickyWrite?: boolean;
    /** Duration (ms) to read from primary after a write (default: 1000). */
    stickyWindow?: number;
}

export interface HealthCheckResult {
    healthy: boolean;
    lastChecked: number;
}

export class ReplicaManager {
    constructor(options?: ReplicaManagerOptions);

    /** Number of registered replicas. */
    readonly replicaCount: number;

    /** Set the primary (read-write) adapter. */
    setPrimary(adapter: any): void;
    /** Add a read replica adapter. */
    addReplica(adapter: any): void;
    /** Get an adapter for read operations (respects strategy, health, sticky writes). */
    getReadAdapter(): any;
    /** Get the primary adapter for write operations (updates sticky window). */
    getWriteAdapter(): any;
    /** Mark a replica as unhealthy. */
    markUnhealthy(adapter: any): void;
    /** Mark a replica as healthy. */
    markHealthy(adapter: any): void;
    /** Run a health check on all replicas. */
    healthCheck(): Promise<HealthCheckResult[]>;
    /** Get all adapters (primary + replicas). */
    getAllAdapters(): any[];
    /** Close all adapters (primary + replicas). */
    closeAll(): Promise<void>;
}

// --- Multi-Tenancy (Phase 4) ----------------------------------------

export interface TenantManagerOptions {
    /** Tenancy strategy. */
    strategy?: 'row' | 'schema';
    /** Column name for row-level tenancy. */
    tenantColumn?: string;
    /** Default schema name (schema strategy). */
    defaultSchema?: string;
    /** Schema name prefix (schema strategy). */
    schemaPrefix?: string;
}

export interface TenantMiddlewareOptions {
    /** Header to read tenant from. */
    header?: string;
    /** Query parameter name. */
    queryParam?: string;
    /** Custom extraction function. */
    extract?: (req: any) => string | undefined;
    /** Reject requests without tenant. */
    required?: boolean;
}

export class TenantManager {
    constructor(db: Database, options?: TenantManagerOptions);

    /** The tenancy strategy. */
    readonly strategy: string;
    /** The tenant column name (row strategy). */
    readonly tenantColumn: string;

    /** Set the current tenant for subsequent queries. */
    setCurrentTenant(tenantId: string): TenantManager;
    /** Get the current tenant ID. */
    getCurrentTenant(): string | null;
    /** Clear the current tenant context. */
    clearTenant(): TenantManager;
    /** Execute a function within a specific tenant context. */
    withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
    /** Register a Model for tenant scoping. */
    addModel(ModelClass: typeof Model): TenantManager;
    /** Register multiple Models for tenant scoping. */
    addModels(...models: Array<typeof Model>): TenantManager;
    /** Create a new tenant (schema or row). */
    createTenant(tenantId: string): Promise<void>;
    /** Drop a tenant. */
    dropTenant(tenantId: string, options?: { cascade?: boolean }): Promise<void>;
    /** List all known tenant IDs. */
    listTenants(): string[];
    /** Check if a tenant exists. */
    hasTenant(tenantId: string): boolean;
    /** Returns tenant extraction middleware. */
    middleware(options?: TenantMiddlewareOptions): (req: any, res: any, next: () => void) => void;
    /** Run migrations for a specific tenant. */
    migrate(migrator: Migrator, tenantId: string): Promise<MigrateResult>;
    /** Run migrations for all known tenants. */
    migrateAll(migrator: Migrator): Promise<Map<string, MigrateResult>>;
}

// --- Audit Logging (Phase 4) ----------------------------------------

export interface AuditLogOptions {
    /** Table name for audit entries. */
    table?: string;
    /** Models to audit. */
    include?: Array<typeof Model>;
    /** Models to exclude from auditing. */
    exclude?: Array<typeof Model>;
    /** Fields to never log. */
    excludeFields?: string[];
    /** Context property for actor identifier. */
    actorField?: string;
    /** Separate database for audit storage. */
    storage?: Database;
    /** Include timestamps in entries. */
    timestamps?: boolean;
    /** Store field-level diffs for updates. */
    diffs?: boolean;
}

export interface AuditEntry {
    id: number;
    action: 'create' | 'update' | 'delete';
    table_name: string;
    record_id: string | null;
    actor: string | null;
    old_values: Record<string, any> | null;
    new_values: Record<string, any> | null;
    diff: Array<{ field: string; from: any; to: any }> | null;
    timestamp: string;
}

export interface AuditTrailOptions {
    /** Filter by table name. */
    table?: string;
    /** Filter by action. */
    action?: 'create' | 'update' | 'delete';
    /** Filter by record ID. */
    recordId?: string;
    /** Filter by actor. */
    actor?: string;
    /** ISO timestamp lower bound. */
    since?: string;
    /** ISO timestamp upper bound. */
    until?: string;
    /** Maximum entries (default 100). */
    limit?: number;
    /** Skip entries. */
    offset?: number;
    /** Sort order (default 'desc'). */
    order?: 'asc' | 'desc';
}

export interface AuditMiddlewareOptions {
    /** Custom actor extraction function. */
    extract?: (req: any) => string | undefined;
    /** Header to read actor from. */
    header?: string;
}

export class AuditLog {
    constructor(db: Database, options?: AuditLogOptions);

    /** Initialize the audit table and attach hooks. */
    install(): Promise<AuditLog>;
    /** Set the current actor. */
    setActor(actor: string): AuditLog;
    /** Get the current actor. */
    getActor(): string | null;
    /** Execute a function within a specific actor context. */
    withActor<T>(actor: string, fn: () => Promise<T>): Promise<T>;
    /** Compute a diff between two objects. */
    diff(oldValues: Record<string, any>, newValues: Record<string, any>): Array<{ field: string; from: any; to: any }>;
    /** Query the audit trail. */
    trail(options?: AuditTrailOptions): Promise<AuditEntry[]>;
    /** Get audit history for a specific record. */
    history(table: string, recordId: string | number, options?: AuditTrailOptions): Promise<AuditEntry[]>;
    /** Get audit entries grouped by actor. */
    byActor(options?: AuditTrailOptions): Promise<Map<string, AuditEntry[]>>;
    /** Count audit entries. */
    count(options?: AuditTrailOptions): Promise<number>;
    /** Purge old audit entries. */
    purge(options: { before?: string; table?: string; keepLast?: number }): Promise<number>;
    /** Returns actor extraction middleware. */
    middleware(options?: AuditMiddlewareOptions): (req: any, res: any, next: () => void) => void;
}

// --- Plugin System (Phase 4) ----------------------------------------

export interface PluginDefinition {
    /** Unique plugin name. */
    name: string;
    /** Plugin version string. */
    version?: string;
    /** Install function called on registration. */
    install: (manager: PluginManager, options?: Record<string, any>) => void;
    /** Boot function called after all plugins are registered. */
    boot?: (manager: PluginManager, options?: Record<string, any>) => Promise<void> | void;
    /** Cleanup function. */
    uninstall?: (manager: PluginManager) => void;
    /** Required plugin names. */
    dependencies?: string[];
}

export interface PluginInfo {
    name: string;
    version: string;
    hasBootFn: boolean;
}

export class PluginManager {
    constructor(db?: Database);

    /** Number of registered plugins. */
    readonly size: number;

    /** Register a plugin. */
    register(plugin: PluginDefinition, options?: Record<string, any>): PluginManager;
    /** Register multiple plugins. */
    registerAll(...plugins: Array<PluginDefinition | [PluginDefinition, Record<string, any>]>): PluginManager;
    /** Unregister a plugin by name. */
    unregister(name: string): PluginManager;
    /** Boot all registered plugins. */
    boot(): Promise<PluginManager>;
    /** Register a hook listener. */
    hook(name: string, callback: (...args: any[]) => any): PluginManager;
    /** Remove a hook listener. */
    unhook(name: string, callback: Function): PluginManager;
    /** Execute all listeners for a hook. */
    runHook(name: string, ...args: any[]): Promise<any>;
    /** Check if listeners exist for a hook. */
    hasHook(name: string): boolean;
    /** Check if a plugin is registered. */
    has(name: string): boolean;
    /** Get a registered plugin by name. */
    get(name: string): PluginDefinition | undefined;
    /** Get options for a registered plugin. */
    getOptions(name: string): Record<string, any> | undefined;
    /** List all registered plugin names. */
    list(): string[];
    /** Get info about all registered plugins. */
    info(): PluginInfo[];
}

// --- Stored Procedures & Functions (Phase 4) ------------------------

export interface ProcedureParam {
    /** Parameter name. */
    name: string;
    /** SQL type. */
    type: string;
    /** IN, OUT, or INOUT (procedures only). */
    direction?: 'IN' | 'OUT' | 'INOUT';
}

export interface StoredProcedureOptions {
    /** Procedure parameters. */
    params?: ProcedureParam[];
    /** Procedure body (SQL). */
    body: string;
    /** Language (sql, plpgsql). */
    language?: string;
    /** Adapter-specific options. */
    options?: Record<string, any>;
}

export class StoredProcedure {
    constructor(name: string, options: StoredProcedureOptions);

    /** Procedure name. */
    readonly name: string;

    /** Create the procedure in the database. */
    create(db: Database): Promise<void>;
    /** Drop the procedure. */
    drop(db: Database, options?: { ifExists?: boolean }): Promise<void>;
    /** Execute the procedure with arguments. */
    execute(db: Database, args?: any[]): Promise<any>;
    /** Check if the procedure exists. */
    exists(db: Database): Promise<boolean>;
}

export interface StoredFunctionOptions {
    /** Function parameters. */
    params?: Array<{ name: string; type: string }>;
    /** Return type. */
    returns: string;
    /** Function body (SQL). */
    body: string;
    /** Language. */
    language?: string;
    /** Whether the function is deterministic (MySQL). */
    deterministic?: boolean;
    /** PostgreSQL volatility (STABLE, VOLATILE, IMMUTABLE). */
    volatility?: string;
}

export class StoredFunction {
    constructor(name: string, options: StoredFunctionOptions);

    /** Function name. */
    readonly name: string;

    /** Create the function in the database. */
    create(db: Database): Promise<void>;
    /** Drop the function. */
    drop(db: Database, options?: { ifExists?: boolean }): Promise<void>;
    /** Call the function and return its result. */
    call(db: Database, args?: any[]): Promise<any>;
    /** Check if the function exists. */
    exists(db: Database): Promise<boolean>;
}

export interface TriggerDefinition {
    /** Table the trigger is on. */
    table: string;
    /** BEFORE, AFTER, or INSTEAD OF. */
    timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    /** INSERT, UPDATE, or DELETE. */
    event: 'INSERT' | 'UPDATE' | 'DELETE';
    /** Trigger body (SQL). */
    body: string;
    /** ROW or STATEMENT. */
    forEach?: 'ROW' | 'STATEMENT';
    /** Optional WHEN condition. */
    when?: string;
}

export class TriggerManager {
    constructor(db: Database);

    /** Define a trigger. */
    define(name: string, options: TriggerDefinition): TriggerManager;
    /** Create a trigger in the database. */
    create(name: string): Promise<void>;
    /** Create all defined triggers. */
    createAll(): Promise<string[]>;
    /** Drop a trigger. */
    drop(name: string, options?: { table?: string; ifExists?: boolean }): Promise<void>;
    /** List all defined trigger names. */
    list(): string[];
    /** Get a trigger definition by name. */
    get(name: string): TriggerDefinition | undefined;
}

// --- CLI (Phase 4) --------------------------------------------------

export class CLI {
    constructor(argv?: string[]);
    /** Run the CLI command. */
    run(): Promise<void>;
}

/** Create and run the CLI. */
export function runCLI(argv?: string[]): Promise<void>;
