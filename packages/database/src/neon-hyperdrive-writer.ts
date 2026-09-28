import { logger } from "@formbricks/logger";
import type { HyperdriveEnv, hasHyperdriveBinding } from "./neon-hyperdrive-adapter";

/**
 * Neon Hyperdrive 写操作适配器
 *
 * 提供与 Prisma 类似的写入接口，用于在 Cloudflare Workers 环境中
 * 通过 Hyperdrive 绑定直接写入 Neon PostgreSQL 数据库。
 *
 * 使用场景：
 * - 当应用部署在 Cloudflare Workers 上，需要使用 Hyperdrive 绑定时
 * - 需要执行 INSERT、UPDATE、DELETE 等写操作
 * - 需要事务支持以保证数据一致性
 * - 需要直接执行 SQL 而不依赖 Prisma ORM 时
 */

/**
 * 写入操作结果类型定义
 */
export interface WriteResult<T = unknown> {
  /**
   * 受影响的行数
   */
  rowCount: number;
  /**
   * 返回的行数据（如果查询包含 RETURNING 子句）
   */
  rows: T[];
  /**
   * 最后插入行的 ID（仅适用于 INSERT 操作）
   */
  lastInsertId?: number | string;
}

/**
 * 事务状态
 */
export enum TransactionState {
  /**
   * 事务未开始
   */
  IDLE = "IDLE",
  /**
   * 事务进行中
   */
  ACTIVE = "ACTIVE",
  /**
   * 事务已提交
   */
  COMMITTED = "COMMITTED",
  /**
   * 事务已回滚
   */
  ROLLED_BACK = "ROLLED_BACK",
}

/**
 * 事务客户端接口
 * 用于在事务中执行多个写操作
 */
export interface ITransactionClient {
  /**
   * 在事务中执行 INSERT 操作
   * @param sql - INSERT SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 插入的行数据
   */
  insert<T = unknown>(sql: string, params?: unknown[]): Promise<WriteResult<T>>;

  /**
   * 在事务中执行 UPDATE 操作
   * @param sql - UPDATE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 更新的行数据
   */
  update<T = unknown>(sql: string, params?: unknown[]): Promise<WriteResult<T>>;

  /**
   * 在事务中执行 DELETE 操作
   * @param sql - DELETE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 删除的行数据
   */
  delete<T = unknown>(sql: string, params?: unknown[]): Promise<WriteResult<T>>;

  /**
   * 在事务中执行原始 SQL 语句
   * @param sql - SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 执行结果
   */
  execute(sql: string, params?: unknown[]): Promise<WriteResult>;

  /**
   * 在事务中执行 SELECT 查询
   * @param sql - SELECT SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 查询结果行数组
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * 事务选项
 */
export interface TransactionOptions {
  /**
   * 事务超时时间（毫秒），默认 30 秒
   */
  timeout?: number;
  /**
   * 事务隔离级别，默认 'READ COMMITTED'
   */
  isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
}

/**
 * 执行 INSERT 操作
 *
 * 向指定表中插入新记录。支持参数化查询以防止 SQL 注入。
 * 如果 SQL 包含 RETURNING 子句，将返回插入的行数据。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param sql - INSERT SQL 语句（使用 ? 作为参数占位符）
 * @param params - 查询参数数组（可选），按顺序替换 SQL 中的 ? 占位符
 * @returns Promise<WriteResult> 插入操作的结果
 *
 * @example
 * ```typescript
 * // 插入单条记录
 * const result = await insert(env, 
 *   'INSERT INTO users (name, email) VALUES (?, ?)',
 *   ['John Doe', 'john@example.com']
 * );
 * console.log(`Inserted ${result.rowCount} row(s)`);
 *
 * // 插入并返回数据
 * const resultWithReturn = await insert<User>(env,
 *   'INSERT INTO users (name, email) VALUES (?, ?) RETURNING *',
 *   ['Jane Doe', 'jane@example.com']
 * );
 * console.log('Inserted user:', resultWithReturn.rows[0]);
 * ```
 */
export async function insert<T = unknown>(
  env: HyperdriveEnv,
  sql: string,
  params: unknown[] = []
): Promise<WriteResult<T>> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        sql: sql.substring(0, 200),
        params,
        rowCount: result.rowCount,
      },
      "INSERT operation executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows as T[],
      lastInsertId: extractLastInsertId(result.rows),
    };
  } catch (error) {
    logger.error(
      {
        sql,
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive INSERT failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during INSERT operation");
  }
}

/**
 * 执行 UPDATE 操作
 *
 * 更新指定表中的记录。支持参数化查询以防止 SQL 注入。
 * 如果 SQL 包含 RETURNING 子句，将返回更新后的行数据。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param sql - UPDATE SQL 语句（使用 ? 作为参数占位符）
 * @param params - 查询参数数组（可选），按顺序替换 SQL 中的 ? 占位符
 * @returns Promise<WriteResult> 更新操作的结果
 *
 * @example
 * ```typescript
 * // 更新单条记录
 * const result = await update(env,
 *   'UPDATE users SET name = ? WHERE id = ?',
 *   ['John Smith', 1]
 * );
 * console.log(`Updated ${result.rowCount} row(s)`);
 *
 * // 更新并返回数据
 * const resultWithReturn = await update<User>(env,
 *   'UPDATE users SET status = ? WHERE id = ? RETURNING *',
 *   ['active', 1]
 * );
 * console.log('Updated user:', resultWithReturn.rows[0]);
 * ```
 */
export async function update<T = unknown>(
  env: HyperdriveEnv,
  sql: string,
  params: unknown[] = []
): Promise<WriteResult<T>> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        sql: sql.substring(0, 200),
        params,
        rowCount: result.rowCount,
      },
      "UPDATE operation executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows as T[],
    };
  } catch (error) {
    logger.error(
      {
        sql,
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive UPDATE failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during UPDATE operation");
  }
}

/**
 * 执行 DELETE 操作
 *
 * 删除指定表中的记录。支持参数化查询以防止 SQL 注入。
 * 如果 SQL 包含 RETURNING 子句，将返回被删除的行数据。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param sql - DELETE SQL 语句（使用 ? 作为参数占位符）
 * @param params - 查询参数数组（可选），按顺序替换 SQL 中的 ? 占位符
 * @returns Promise<WriteResult> 删除操作的结果
 *
 * @example
 * ```typescript
 * // 删除单条记录
 * const result = await deleteRecord(env,
 *   'DELETE FROM users WHERE id = ?',
 *   [1]
 * );
 * console.log(`Deleted ${result.rowCount} row(s)`);
 *
 * // 删除并返回被删除的数据
 * const resultWithReturn = await deleteRecord<User>(env,
 *   'DELETE FROM users WHERE status = ? RETURNING *',
 *   ['inactive']
 * );
 * console.log('Deleted users:', resultWithReturn.rows);
 * ```
 */
export async function deleteRecord<T = unknown>(
  env: HyperdriveEnv,
  sql: string,
  params: unknown[] = []
): Promise<WriteResult<T>> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        sql: sql.substring(0, 200),
        params,
        rowCount: result.rowCount,
      },
      "DELETE operation executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows as T[],
    };
  } catch (error) {
    logger.error(
      {
        sql,
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive DELETE failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during DELETE operation");
  }
}

/**
 * 执行原始 SQL 语句
 *
 * 执行任意 SQL 语句（DDL、DML 等）。支持参数化查询以防止 SQL 注入。
 * 适用于复杂的写操作或数据库管理操作。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param sql - SQL 语句（使用 ? 作为参数占位符）
 * @param params - 查询参数数组（可选），按顺序替换 SQL 中的 ? 占位符
 * @returns Promise<WriteResult> 执行结果
 *
 * @example
 * ```typescript
 * // 执行批量更新
 * const result = await execute(env,
 *   'UPDATE users SET last_login = NOW() WHERE status = ?',
 *   ['active']
 * );
 * console.log(`Updated ${result.rowCount} users`);
 *
 * // 执行存储过程
 * await execute(env, 'CALL refresh_user_cache()', []);
 *
 * // 执行 DDL（谨慎使用）
 * await execute(env, 'CREATE INDEX idx_users_email ON users(email)', []);
 * ```
 */
export async function execute(
  env: HyperdriveEnv,
  sql: string,
  params: unknown[] = []
): Promise<WriteResult> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        sql: sql.substring(0, 200),
        params,
        rowCount: result.rowCount,
      },
      "Raw SQL executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows,
    };
  } catch (error) {
    logger.error(
      {
        sql,
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive execute failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during execute operation");
  }
}

/**
 * 开始一个新事务
 *
 * 创建事务上下文，允许执行多个写操作。必须配合 commit 或 rollback 使用。
 * 注意：Hyperdrive 的事务需要通过显式的 BEGIN/COMMIT/ROLLBACK 语句管理。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param options - 事务选项（超时、隔离级别等）
 * @returns Promise<ITransactionClient> 事务客户端
 *
 * @example
 * ```typescript
 * const tx = await begin(env);
 * try {
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Alice']);
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Bob']);
 *   await commit(tx);
 * } catch (error) {
 *   await rollback(tx);
 *   throw error;
 * }
 * ```
 */
export async function begin(
  env: HyperdriveEnv,
  options: TransactionOptions = {}
): Promise<ITransactionClient> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const { isolationLevel = "READ COMMITTED" } = options;

    logger.debug({ isolationLevel }, "Beginning transaction");

    // 设置事务隔离级别
    await env.HYPERDRIVE.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    
    // 开始事务
    await env.HYPERDRIVE.query("BEGIN");

    const transactionClient = createTransactionClient(env);

    logger.info("Transaction started successfully");
    return transactionClient;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to begin transaction"
    );
    throw error instanceof Error ? error : new Error("Failed to begin transaction");
  }
}

/**
 * 提交事务
 *
 * 提交事务中的所有操作，使更改永久生效。
 * 必须在事务成功后调用，否则数据更改将被丢弃。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @returns Promise<void>
 *
 * @example
 * ```typescript
 * const tx = await begin(env);
 * try {
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Alice']);
 *   await commit(env);
 *   console.log('Transaction committed successfully');
 * } catch (error) {
 *   await rollback(env);
 *   console.error('Transaction failed:', error);
 * }
 * ```
 */
export async function commit(env: HyperdriveEnv): Promise<void> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    logger.debug("Committing transaction");

    await env.HYPERDRIVE.query("COMMIT");

    logger.info("Transaction committed successfully");
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to commit transaction"
    );
    throw error instanceof Error ? error : new Error("Failed to commit transaction");
  }
}

/**
 * 回滚事务
 *
 * 回滚事务中的所有操作，撤销所有未提交的更改。
 * 应在事务失败或发生错误时调用，以保证数据一致性。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @returns Promise<void>
 *
 * @example
 * ```typescript
 * const tx = await begin(env);
 * try {
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Alice']);
 *   // 某些操作失败...
 *   throw new Error('Something went wrong');
 * } catch (error) {
 *   await rollback(env);
 *   console.log('Transaction rolled back');
 * }
 * ```
 */
export async function rollback(env: HyperdriveEnv): Promise<void> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    logger.debug("Rolling back transaction");

    await env.HYPERDRIVE.query("ROLLBACK");

    logger.info("Transaction rolled back successfully");
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to rollback transaction"
    );
    throw error instanceof Error ? error : new Error("Failed to rollback transaction");
  }
}

/**
 * 执行事务操作（自动提交/回滚）
 *
 * 自动管理事务生命周期：开始时创建事务，成功时提交，失败时回滚。
 * 这是推荐的事务使用方式，可以避免手动管理事务状态的错误。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param callback - 事务回调函数，接收事务客户端作为参数
 * @param options - 事务选项
 * @returns Promise<T> 回调函数的返回值
 *
 * @example
 * ```typescript
 * // 自动事务管理
 * const result = await transaction(env, async (tx) => {
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Alice']);
 *   await tx.insert('INSERT INTO users (name) VALUES (?)', ['Bob']);
 *   return { success: true, message: 'Users created' };
 * });
 * console.log(result); // { success: true, message: 'Users created' }
 *
 * // 事务失败时自动回滚
 * try {
 *   await transaction(env, async (tx) => {
 *     await tx.insert('INSERT INTO users (name) VALUES (?)', ['Alice']);
 *     throw new Error('Simulated error'); // 触发回滚
 *   });
 * } catch (error) {
 *   console.log('Transaction was rolled back:', error.message);
 * }
 * ```
 */
export async function transaction<T>(
  env: HyperdriveEnv,
  callback: (tx: ITransactionClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  let transactionClient: ITransactionClient | null = null;

  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    logger.debug("Starting automated transaction");

    // 开始事务
    transactionClient = await begin(env, options);

    // 执行回调函数
    const result = await callback(transactionClient);

    // 提交事务
    await commit(env);

    logger.info("Automated transaction completed successfully");
    return result;
  } catch (error) {
    // 发生错误时回滚事务
    if (transactionClient) {
      try {
        await rollback(env);
        logger.info("Transaction rolled back due to error");
      } catch (rollbackError) {
        logger.error(
          {
            originalError: error instanceof Error ? error.message : String(error),
            rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
          "Failed to rollback transaction after error"
        );
      }
    }

    throw error instanceof Error ? error : new Error("Transaction failed with unknown error");
  }
}

/**
 * 创建事务客户端
 *
 * 内部函数，用于创建事务上下文中的操作客户端。
 * 所有操作都在同一个事务中执行。
 *
 * @param env - Cloudflare Workers 环境对象
 * @returns ITransactionClient 事务客户端
 */
function createTransactionClient(env: HyperdriveEnv): ITransactionClient {
  return {
    /**
     * 在事务中执行 INSERT 操作
     */
    async insert<T = unknown>(sql: string, params: unknown[] = []): Promise<WriteResult<T>> {
      try {
        const result = await env.HYPERDRIVE.query(sql, params);
        return {
          rowCount: result.rowCount,
          rows: result.rows as T[],
          lastInsertId: extractLastInsertId(result.rows),
        };
      } catch (error) {
        logger.error(
          { sql, params, error: error instanceof Error ? error.message : String(error) },
          "Transaction INSERT failed"
        );
        throw error;
      }
    },

    /**
     * 在事务中执行 UPDATE 操作
     */
    async update<T = unknown>(sql: string, params: unknown[] = []): Promise<WriteResult<T>> {
      try {
        const result = await env.HYPERDRIVE.query(sql, params);
        return {
          rowCount: result.rowCount,
          rows: result.rows as T[],
        };
      } catch (error) {
        logger.error(
          { sql, params, error: error instanceof Error ? error.message : String(error) },
          "Transaction UPDATE failed"
        );
        throw error;
      }
    },

    /**
     * 在事务中执行 DELETE 操作
     */
    async delete<T = unknown>(sql: string, params: unknown[] = []): Promise<WriteResult<T>> {
      try {
        const result = await env.HYPERDRIVE.query(sql, params);
        return {
          rowCount: result.rowCount,
          rows: result.rows as T[],
        };
      } catch (error) {
        logger.error(
          { sql, params, error: error instanceof Error ? error.message : String(error) },
          "Transaction DELETE failed"
        );
        throw error;
      }
    },

    /**
     * 在事务中执行原始 SQL 语句
     */
    async execute(sql: string, params: unknown[] = []): Promise<WriteResult> {
      try {
        const result = await env.HYPERDRIVE.query(sql, params);
        return {
          rowCount: result.rowCount,
          rows: result.rows,
        };
      } catch (error) {
        logger.error(
          { sql, params, error: error instanceof Error ? error.message : String(error) },
          "Transaction execute failed"
        );
        throw error;
      }
    },

    /**
     * 在事务中执行 SELECT 查询
     */
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      try {
        const result = await env.HYPERDRIVE.query(sql, params);
        return result.rows as T[];
      } catch (error) {
        logger.error(
          { sql, params, error: error instanceof Error ? error.message : String(error) },
          "Transaction query failed"
        );
        throw error;
      }
    },
  };
}

/**
 * 从查询结果中提取最后插入的 ID
 *
 * 内部函数，用于从 INSERT 操作的结果中提取自增 ID。
 * 支持 PostgreSQL 的 RETURNING id 语法。
 *
 * @param rows - 查询结果行
 * @returns 最后插入的 ID，如果无法提取则返回 undefined
 */
function extractLastInsertId(rows: unknown[]): number | string | undefined {
  if (!Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }

  const firstRow = rows[0] as Record<string, unknown>;
  
  // 尝试从常见的 ID 字段名中提取
  const idFields = ["id", "ID", "Id", "user_id", "userId", "rowid"];
  
  for (const field of idFields) {
    if (field in firstRow) {
      return firstRow[field] as number | string;
    }
  }

  return undefined;
}

/**
 * 批量插入操作
 *
 * 高效地插入多条记录。使用单个 SQL 语句插入多行数据，
 * 比多次调用 insert() 更高效。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param table - 目标表名
 * @param columns - 列名数组
 * @param values - 二维数组，每行包含对应列的值
 * @returns Promise<WriteResult> 批量插入的结果
 *
 * @example
 * ```typescript
 * // 批量插入用户
 * const result = await batchInsert(env, 'users', 
 *   ['name', 'email', 'status'],
 *   [
 *     ['Alice', 'alice@example.com', 'active'],
 *     ['Bob', 'bob@example.com', 'active'],
 *     ['Charlie', 'charlie@example.com', 'inactive']
 *   ]
 * );
 * console.log(`Inserted ${result.rowCount} users`);
 * ```
 */
export async function batchInsert(
  env: HyperdriveEnv,
  table: string,
  columns: string[],
  values: unknown[][]
): Promise<WriteResult> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    // 验证表名
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    // 验证列名
    for (const column of columns) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
        throw new Error(`Invalid column name: ${column}`);
      }
    }

    if (values.length === 0) {
      return { rowCount: 0, rows: [] };
    }

    // 构建批量插入 SQL
    const columnClause = columns.map((col) => `"${col}"`).join(", ");
    const valuePlaceholders = values
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");
    
    const sql = `INSERT INTO "${table}" (${columnClause}) VALUES ${valuePlaceholders}`;
    
    // 扁平化参数数组
    const params = values.flat();

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        table,
        rowCount: result.rowCount,
        batch: values.length,
      },
      "Batch INSERT executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows,
    };
  } catch (error) {
    logger.error(
      {
        table,
        columns,
        error: error instanceof Error ? error.message : String(error),
      },
      "Batch INSERT failed"
    );
    throw error instanceof Error ? error : new Error("Batch INSERT operation failed");
  }
}

/**
 * 批量更新操作
 *
 * 使用 CASE WHEN 语句高效地更新多条记录的不同值。
 * 比多次调用 update() 更高效。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param table - 目标表名
 * @param idColumn - 用于标识记录的 ID 列名
 * @param updateColumn - 要更新的列名
 * @param updates - 更新数据数组，每项包含 id 和 value
 * @returns Promise<WriteResult> 批量更新的结果
 *
 * @example
 * ```typescript
 * // 批量更新用户状态
 * const result = await batchUpdate(env, 'users', 'id', 'status', [
 *   { id: 1, value: 'active' },
 *   { id: 2, value: 'inactive' },
 *   { id: 3, value: 'active' }
 * ]);
 * console.log(`Updated ${result.rowCount} users`);
 * ```
 */
export async function batchUpdate(
  env: HyperdriveEnv,
  table: string,
  idColumn: string,
  updateColumn: string,
  updates: Array<{ id: number | string; value: unknown }>
): Promise<WriteResult> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    // 验证表名和列名
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(idColumn)) {
      throw new Error(`Invalid ID column name: ${idColumn}`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(updateColumn)) {
      throw new Error(`Invalid update column name: ${updateColumn}`);
    }

    if (updates.length === 0) {
      return { rowCount: 0, rows: [] };
    }

    // 构建 CASE WHEN 语句
    const cases: string[] = [];
    const params: unknown[] = [];
    const ids: Array<number | string> = [];

    for (const update of updates) {
      cases.push(`WHEN ? THEN ?`);
      params.push(update.id, update.value);
      ids.push(update.id);
    }

    const idPlaceholders = ids.map(() => "?").join(", ");
    const sql = `
      UPDATE "${table}"
      SET "${updateColumn}" = CASE "${idColumn}"
        ${cases.join("\n        ")}
        ELSE "${updateColumn}"
      END
      WHERE "${idColumn}" IN (${idPlaceholders})
    `;

    params.push(...ids);

    const result = await env.HYPERDRIVE.query(sql, params);

    logger.debug(
      {
        table,
        rowCount: result.rowCount,
        batch: updates.length,
      },
      "Batch UPDATE executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows,
    };
  } catch (error) {
    logger.error(
      {
        table,
        idColumn,
        updateColumn,
        error: error instanceof Error ? error.message : String(error),
      },
      "Batch UPDATE failed"
    );
    throw error instanceof Error ? error : new Error("Batch UPDATE operation failed");
  }
}

/**
 * Upsert 操作（插入或更新）
 *
 * 如果记录不存在则插入，如果存在则更新。
 * 使用 PostgreSQL 的 ON CONFLICT 语法实现。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param table - 目标表名
 * @param columns - 列名数组
 * @param values - 要插入或更新的值数组
 * @param conflictColumns - 用于检测冲突的列名数组（唯一约束列）
 * @param updateColumns - 冲突时要更新的列名数组（可选，默认更新所有非冲突列）
 * @returns Promise<WriteResult> Upsert 操作的结果
 *
 * @example
 * ```typescript
 * // 插入或更新用户
 * const result = await upsert(env, 'users',
 *   ['email', 'name', 'updated_at'],
 *   ['john@example.com', 'John Doe', new Date()],
 *   ['email'], // 冲突列
 *   ['name', 'updated_at'] // 更新列
 * );
 * console.log(`Upserted ${result.rowCount} row(s)`);
 * ```
 */
export async function upsert(
  env: HyperdriveEnv,
  table: string,
  columns: string[],
  values: unknown[],
  conflictColumns: string[],
  updateColumns?: string[]
): Promise<WriteResult> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    // 验证表名和列名
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    for (const column of columns) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
        throw new Error(`Invalid column name: ${column}`);
      }
    }

    for (const column of conflictColumns) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
        throw new Error(`Invalid conflict column name: ${column}`);
      }
    }

    // 确定要更新的列
    const columnsToUpdate = updateColumns || columns.filter((col) => !conflictColumns.includes(col));

    // 构建 SQL
    const columnClause = columns.map((col) => `"${col}"`).join(", ");
    const valuePlaceholders = columns.map(() => "?").join(", ");
    const conflictClause = conflictColumns.map((col) => `"${col}"`).join(", ");
    
    const updateClause = columnsToUpdate
      .map((col) => `"${col}" = EXCLUDED."${col}"`)
      .join(", ");

    const sql = `
      INSERT INTO "${table}" (${columnClause})
      VALUES (${valuePlaceholders})
      ON CONFLICT (${conflictClause})
      DO UPDATE SET ${updateClause}
    `;

    const result = await env.HYPERDRIVE.query(sql, values);

    logger.debug(
      {
        table,
        rowCount: result.rowCount,
      },
      "Upsert executed"
    );

    return {
      rowCount: result.rowCount,
      rows: result.rows,
    };
  } catch (error) {
    logger.error(
      {
        table,
        columns,
        conflictColumns,
        error: error instanceof Error ? error.message : String(error),
      },
      "Upsert failed"
    );
    throw error instanceof Error ? error : new Error("Upsert operation failed");
  }
}
