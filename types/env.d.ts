// --- Env Field Definition ----------------------------------------

export interface EnvFieldDef {
    /** Value type for coercion. */
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'port' | 'array' | 'json' | 'url' | 'enum';
    /** Field is required. */
    required?: boolean;
    /** Default value (or function returning a value). */
    default?: any | (() => any);
    /** Min value (number/integer) or min length (string). */
    min?: number;
    /** Max value (number/integer) or max length (string). */
    max?: number;
    /** Pattern match (string type). */
    match?: RegExp;
    /** Delimiter for array type. Default: ','. */
    separator?: string;
    /** Allowed values for enum type. */
    values?: string[];
}

export type EnvSchema = Record<string, EnvFieldDef>;

export interface EnvLoadOptions {
    /** Directory to load .env files from. Default: `process.cwd()`. */
    path?: string;
    /** Write file values into `process.env`. Default: false. */
    override?: boolean;
}

// --- Env Proxy ---------------------------------------------------

export interface Env {
    /**
     * Get a variable by key.
     */
    (key: string): any;

    /**
     * Load environment variables, optionally with a typed schema.
     */
    load(schema?: EnvSchema, options?: EnvLoadOptions): Record<string, any>;

    /**
     * Get a variable by key.
     */
    get(key: string): any;

    /**
     * Get a variable by key, throwing if missing.
     */
    require(key: string): any;

    /**
     * Check if a variable exists (in store or `process.env`).
     */
    has(key: string): boolean;

    /**
     * Return all loaded variables.
     */
    all(): Record<string, any>;

    /**
     * Clear all loaded variables from the internal store.
     */
    reset(): void;

    /**
     * Parse a raw `.env` string into key-value pairs.
     */
    parse(src: string): Record<string, string>;

    /**
     * Property access for variables (e.g., `env.PORT`).
     */
    [key: string]: any;
}

export const env: Env;
