import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { logger } from "@formbricks/logger";

/**
 * Neon Serverless Driver 适配器接口
 * 定义了适配器的基本操作方法
 */
export interface INeonServerlessAdapter {
  /**
   * 执行 SELECT 查询
   * @param sql - SQL 查询语句
   * @param params - 参数化查询的参数数组
   * @returns 查询结果行数组
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 执行 INSERT 操作
   * @param sql - INSERT SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 插入的行数据
   */
  insert<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 执行 UPDATE 操作
   * @param sql - UPDATE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 更新的行数据
   */
  update<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 执行 DELETE 操作
   * @param sql - DELETE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 删除的行数据
   */
  delete<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 执行原始 SQL 语句（不返回结果）
   * @param sql - SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns Promise<void>
   */
  execute(sql: string, params?: unknown[]): Promise<void>;

  /**
   * 执行事务操作
   * @param callback - 事务回调函数，接收事务客户端
   * @returns 事务执行结果
   */
  transaction<T>(callback: (tx: ITransactionClient) => Promise<T>): Promise<T>;

  /**
   * 检查数据库连接是否正常
   * @returns 连接状态
   */
  healthCheck(): Promise<boolean>;

  /**
   * 关闭数据库连接
   * @returns Promise<void>
   */
  close(): Promise<void>;
}

/**
 * 事务客户端接口
 * 用于在事务中执行多个操作
 */
export interface ITransactionClient {
  /**
   * 在事务中执行查询
   * @param sql - SQL 查询语句
   * @param params - 参数化查询的参数数组
   * @returns 查询结果行数组
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 在事务中执行 INSERT 操作
   * @param sql - INSERT SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 插入的行数据
   */
  insert<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 在事务中执行 UPDATE 操作
   * @param sql - UPDATE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 更新的行数据
   */
  update<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * 在事务中执行 DELETE 操作
   * @param sql - DELETE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 删除的行数据
   */
  delete<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Neon Serverless Driver 适配器配置选项
 */
export interface INeonServerlessAdapterConfig {
  /**
   * 数据库连接 URL
   */
  databaseUrl: string;

  /**
   * 是否启用 WebSocket 连接（默认为 true）
   */
  useWebSocket?: boolean;

  /**
   * 连接超时时间（毫秒，默认为 10000ms）
   */
  connectionTimeoutMillis?: number;

  /**
   * 是否启用查询日志（默认为 false）
   */
  enableQueryLogging?: boolean;
}

/**
 * Neon Serverless Driver 适配器实现类
 * 作为不支持 Hyperdrive 的环境的备选方案
 */
class NeonServerlessAdapter implements INeonServerlessAdapter {
  private readonly sql: NeonQueryFunction<false, false>;
  private readonly config: INeonServerlessAdapterConfig;
  private isConnected: boolean = false;

  /**
   * 构造函数
   * @param config - 适配器配置
   */
  constructor(config: INeonServerlessAdapterConfig) {
    this.config = {
      useWebSocket: true,
      connectionTimeoutMillis: 10_000,
      enableQueryLogging: false,
      ...config,
    };

    // 创建 Neon 客户端实例
    // neon 函数会自动处理 WebSocket 连接
    this.sql = neon(this.config.databaseUrl, {
      fullResults: true,
    });

    this.isConnected = true;
    logger.info(
      { adapter: "neon-serverless", useWebSocket: this.config.useWebSocket },
      "Neon serverless adapter initialized"
    );
  }

  /**
   * 执行 SELECT 查询
   * @param sql - SQL 查询语句
   * @param params - 参数化查询的参数数组
   * @returns 查询结果行数组
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.executeQuery<T>("query", sql, params);
  }

  /**
   * 执行 INSERT 操作
   * @param sql - INSERT SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 插入的行数据
   */
  async insert<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.executeQuery<T>("insert", sql, params);
  }

  /**
   * 执行 UPDATE 操作
   * @param sql - UPDATE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 更新的行数据
   */
  async update<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.executeQuery<T>("update", sql, params);
  }

  /**
   * 执行 DELETE 操作
   * @param sql - DELETE SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 删除的行数据
   */
  async delete<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.executeQuery<T>("delete", sql, params);
  }

  /**
   * 执行原始 SQL 语句（不返回结果）
   * @param sql - SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns Promise<void>
   */
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    try {
      if (this.config.enableQueryLogging) {
        logger.debug({ sql, params }, "Executing raw SQL");
      }

      await this.sql(sql, params);

      if (this.config.enableQueryLogging) {
        logger.debug({ sql }, "SQL executed successfully");
      }
    } catch (error) {
      this.handleError("execute", sql, error);
      throw error;
    }
  }

  /**
   * 执行查询的通用方法
   * @param operation - 操作类型
   * @param sql - SQL 语句
   * @param params - 参数化查询的参数数组
   * @returns 查询结果行数组
   */
  private async executeQuery<T>(
    operation: string,
    sql: string,
    params: unknown[]
  ): Promise<T[]> {
    try {
      if (this.config.enableQueryLogging) {
        logger.debug({ operation, sql, params }, "Executing SQL query");
      }

      // 执行查询并返回结果
      const result = await this.sql(sql, params);

      if (this.config.enableQueryLogging) {
        logger.debug(
          { operation, rowCount: Array.isArray(result) ? result.length : 0 },
          "Query executed successfully"
        );
      }

      // 将结果转换为数组格式
      return Array.isArray(result) ? (result as T[]) : [result as T];
    } catch (error) {
      this.handleError(operation, sql, error);
      throw error;
    }
  }

  /**
   * 执行事务操作
   *
   * 使用 neon serverless 的 sql.begin() 事务模式：
   * - 事务回调接收的 txSql 绑定到固定连接，保证事务内所有查询在同一连接上执行，
   *   避免 BEGIN/COMMIT/ROLLBACK 因连接不一致而失效
   * - 回调成功返回时自动提交（COMMIT）
   * - 回调抛出异常时自动回滚（ROLLBACK）并将异常继续向外传播
   *
   * @param callback - 事务回调函数，接收事务客户端
   * @returns 事务执行结果
   */
  async transaction<T>(callback: (tx: ITransactionClient) => Promise<T>): Promise<T> {
    if (!this.isConnected) {
      throw new Error("Cannot execute transaction: adapter is not connected");
    }

    try {
      logger.info("Beginning database transaction");

      const result = await this.sql.begin(async (txSql) => {
        const txClient: ITransactionClient = {
          query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
            try {
              if (this.config.enableQueryLogging) {
                logger.debug({ sql, params, context: "transaction" }, "Executing transaction query");
              }

              const result = await txSql(sql, params);
              return Array.isArray(result) ? (result as T[]) : [result as T];
            } catch (error) {
              this.handleError("transaction.query", sql, error);
              throw error;
            }
          },

          insert: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
            try {
              if (this.config.enableQueryLogging) {
                logger.debug({ sql, params, context: "transaction" }, "Executing transaction insert");
              }

              const result = await txSql(sql, params);
              return Array.isArray(result) ? (result as T[]) : [result as T];
            } catch (error) {
              this.handleError("transaction.insert", sql, error);
              throw error;
            }
          },

          update: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
            try {
              if (this.config.enableQueryLogging) {
                logger.debug({ sql, params, context: "transaction" }, "Executing transaction update");
              }

              const result = await txSql(sql, params);
              return Array.isArray(result) ? (result as T[]) : [result as T];
            } catch (error) {
              this.handleError("transaction.update", sql, error);
              throw error;
            }
          },

          delete: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
            try {
              if (this.config.enableQueryLogging) {
                logger.debug({ sql, params, context: "transaction" }, "Executing transaction delete");
              }

              const result = await txSql(sql, params);
              return Array.isArray(result) ? (result as T[]) : [result as T];
            } catch (error) {
              this.handleError("transaction.delete", sql, error);
              throw error;
            }
          },
        };

        // 执行用户回调；回调抛出的异常会触发 begin() 自动回滚并继续向外传播
        return await callback(txClient);
      });

      logger.info("Transaction committed successfully");
      return result;
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, "Transaction failed");
      throw error;
    }
  }

  /**
   * 检查数据库连接是否正常
   * @returns 连接状态
   */
  async healthCheck(): Promise<boolean> {
    try {
      // 执行简单的健康检查查询
      await this.sql("SELECT 1");
      this.isConnected = true;
      logger.debug("Database health check passed");
      return true;
    } catch (error) {
      this.isConnected = false;
      logger.error(
        { error: error instanceof Error ? error.message : error },
        "Database health check failed"
      );
      return false;
    }
  }

  /**
   * 统一错误处理方法
   * @param operation - 操作类型
   * @param sql - SQL 语句
   * @param error - 错误对象
   */
  private handleError(operation: string, sql: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(
      {
        operation,
        sql: sql.substring(0, 200),
        error: errorMessage,
        stack: errorStack,
      },
      `Neon serverless adapter error during ${operation}`
    );
  }

  /**
   * 关闭数据库连接
   * @returns Promise<void>
   */
  async close(): Promise<void> {
    try {
      // Neon serverless driver 使用 WebSocket，会在查询完成后自动关闭
      // 这里只需要标记连接状态
      this.isConnected = false;
      logger.info("Neon serverless adapter closed");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        "Error closing Neon serverless adapter"
      );
    }
  }
}

/**
 * 创建 Neon Serverless Driver 适配器实例的工厂函数
 * 
 * 使用示例：
 * ```typescript
 * import { createNeonServerlessAdapter } from "./neon-serverless-adapter";
 * 
 * const adapter = createNeonServerlessAdapter(process.env.DATABASE_URL!);
 * 
 * // 执行查询
 * const users = await adapter.query("SELECT * FROM users WHERE active = $1", [true]);
 * 
 * // 执行事务
 * await adapter.transaction(async (tx) => {
 *   await tx.insert("INSERT INTO users (name, email) VALUES ($1, $2)", ["John", "john@example.com"]);
 *   await tx.update("UPDATE users SET last_login = NOW() WHERE email = $1", ["john@example.com"]);
 * });
 * ```
 * 
 * @param databaseUrl - Neon 数据库连接 URL
 * @param config - 可选的配置选项
 * @returns Neon Serverless 适配器实例
 * @throws Error 如果 databaseUrl 未提供
 */
export const createNeonServerlessAdapter = (
  databaseUrl: string,
  config?: Partial<INeonServerlessAdapterConfig>
): INeonServerlessAdapter => {
  if (!databaseUrl) {
    throw new Error(
      "Neon database URL is required. Provide a valid DATABASE_URL environment variable or pass it explicitly."
    );
  }

  // 验证 URL 格式
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error(
      "Invalid Neon database URL format. Expected format: postgresql://user:password@host/database"
    );
  }

  // 检查是否为 Neon 数据库 URL（可选的验证）
  if (!databaseUrl.includes("neon.tech") && !databaseUrl.includes("postgresql://")) {
    logger.warn(
      { url: databaseUrl.replace(/:[^:@/]+@/, ":****@") },
      "URL does not appear to be a standard Neon database URL. Ensure this is correct."
    );
  }

  const adapterConfig: INeonServerlessAdapterConfig = {
    databaseUrl,
    ...config,
  };

  return new NeonServerlessAdapter(adapterConfig);
};

export default createNeonServerlessAdapter;
