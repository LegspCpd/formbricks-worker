import { logger } from "@formbricks/logger";

/**
 * Neon Hyperdrive 读操作适配器
 *
 * 提供与 Prisma 类似的查询接口，用于在 Cloudflare Workers 环境中
 * 通过 Hyperdrive 绑定直接查询 Neon PostgreSQL 数据库。
 *
 * 使用场景：
 * - 当应用部署在 Cloudflare Workers 上，需要使用 Hyperdrive 绑定时
 * - 需要直接执行 SQL 查询而不依赖 Prisma ORM 时
 */

/**
 * 查询结果类型定义
 */
export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

/**
 * 查询选项接口
 */
export interface QueryOptions {
  /**
   * 超时时间（毫秒），默认 30 秒
   */
  timeout?: number;
}

/**
 * 筛选条件操作符
 */
type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE" | "ILIKE" | "IN" | "NOT IN" | "IS NULL" | "IS NOT NULL";

/**
 * 筛选条件接口
 */
export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

/**
 * 排序方向
 */
type SortOrder = "ASC" | "DESC";

/**
 * 排序配置接口
 */
export interface OrderBy {
  column: string;
  order?: SortOrder;
}

/**
 * Select 查询选项
 */
export interface SelectOptions {
  /**
   * 要查询的列，默认 ['*']
   */
  columns?: string[];
  /**
   * 筛选条件（WHERE 子句）
   */
  where?: FilterCondition[];
  /**
   * WHERE 条件之间的逻辑关系，默认 'AND'
   */
  whereLogic?: "AND" | "OR";
  /**
   * 排序配置
   */
  orderBy?: OrderBy[];
  /**
   * 限制返回的行数
   */
  limit?: number;
  /**
   * 跳过的行数（用于分页）
   */
  offset?: number;
}

/**
 * Hyperdrive 环境接口
 * Cloudflare Workers 环境变量中包含的 Hyperdrive 绑定
 */
export interface HyperdriveEnv {
  HYPERDRIVE: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  };
}

/**
 * 验证环境是否包含 Hyperdrive 绑定
 * @param env Cloudflare Workers 环境对象
 * @returns 是否为有效的 Hyperdrive 环境
 */
export function hasHyperdriveBinding(env: unknown): env is HyperdriveEnv {
  if (!env || typeof env !== "object") {
    return false;
  }
  const envObj = env as Record<string, unknown>;
  return (
    typeof envObj.HYPERDRIVE === "object" &&
    envObj.HYPERDRIVE !== null &&
    typeof (envObj.HYPERDRIVE as { query?: unknown }).query === "function"
  );
}

/**
 * 执行原始 SQL 查询
 *
 * 这是最基础的查询方法，直接执行传入的 SQL 语句和参数。
 * 适用于需要执行复杂 SQL 或 Prisma 无法处理的查询场景。
 *
 * @param env - Cloudflare Workers 环境对象，必须包含 HYPERDRIVE 绑定
 * @param sql - SQL 查询语句（使用 ? 作为参数占位符）
 * @param params - 查询参数数组（可选），按顺序替换 SQL 中的 ? 占位符
 * @param options - 查询选项
 * @returns Promise<QueryResult> 查询结果，包含 rows 和 rowCount
 *
 * @example
 * ```typescript
 * const result = await query(env, 'SELECT * FROM users WHERE id = ? AND status = ?', [userId, 'active']);
 * console.log(result.rows); // [{ id: 1, name: 'John', status: 'active' }, ...]
 * console.log(result.rowCount); // 1
 * ```
 */
export async function query<T = unknown>(
  env: HyperdriveEnv,
  sql: string,
  params: unknown[] = [],
  options: QueryOptions = {}
): Promise<QueryResult<T>> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    const { timeout = 30000 } = options;

    // 使用 Promise.race 实现超时控制
    const queryPromise = env.HYPERDRIVE.query(sql, params);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timed out after ${timeout}ms`)), timeout)
    );

    const result = await Promise.race([queryPromise, timeoutPromise]);

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  } catch (error) {
    logger.error(
      {
        sql,
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive query failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during query execution");
  }
}

/**
 * 构建 WHERE 子句
 *
 * 将 FilterCondition 数组转换为 SQL WHERE 子句和参数数组。
 * 内部使用，不直接暴露给外部调用者。
 *
 * @param conditions - 筛选条件数组
 * @param logic - 条件之间的逻辑关系（AND/OR）
 * @returns { whereClause: string, params: unknown[] } WHERE 子句和参数
 */
function buildWhereClause(
  conditions: FilterCondition[],
  logic: "AND" | "OR" = "AND"
): { whereClause: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];

  for (const condition of conditions) {
    const { column, operator, value } = condition;

    // 验证列名格式（防止 SQL 注入）
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }

    switch (operator) {
      case "=":
      case "!=":
      case ">":
      case ">=":
      case "<":
      case "<=":
        clauses.push(`"${column}" ${operator} ?`);
        params.push(value);
        break;
      case "LIKE":
      case "ILIKE":
        clauses.push(`"${column}" ${operator} ?`);
        params.push(value);
        break;
      case "IN":
      case "NOT IN":
        if (!Array.isArray(value)) {
          throw new Error(`Operator ${operator} requires an array value`);
        }
        if (value.length === 0) {
          // IN () 是无效的 SQL，使用 1=0 表示永远为假
          clauses.push("1=0");
        } else {
          const placeholders = value.map(() => "?").join(", ");
          clauses.push(`"${column}" ${operator} (${placeholders})`);
          params.push(...value);
        }
        break;
      case "IS NULL":
      case "IS NOT NULL":
        clauses.push(`"${column}" ${operator}`);
        break;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  return {
    whereClause: clauses.join(` ${logic} `),
    params,
  };
}

/**
 * 执行 SELECT 查询
 *
 * 提供类型安全的 SELECT 查询接口，支持筛选、排序和分页。
 * 这是推荐的查询方式，相比原始 query() 方法更安全、更易用。
 *
 * @param env - Cloudflare Workers 环境对象
 * @param table - 表名
 * @param options - 查询选项（列、筛选、排序、分页等）
 * @returns Promise<QueryResult<T>> 查询结果
 *
 * @example
 * ```typescript
 * // 查询所有活跃用户，按创建时间倒序排列
 * const users = await select<User>(env, 'users', {
 *   columns: ['id', 'name', 'email'],
 *   where: [
 *     { column: 'status', operator: '=', value: 'active' },
 *     { column: 'age', operator: '>=', value: 18 }
 *   ],
 *   orderBy: [{ column: 'created_at', order: 'DESC' }],
 *   limit: 10,
 *   offset: 0
 * });
 * ```
 */
export async function select<T = unknown>(
  env: HyperdriveEnv,
  table: string,
  options: SelectOptions = {}
): Promise<QueryResult<T>> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    // 验证表名格式（防止 SQL 注入）
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    const {
      columns = ["*"],
      where = [],
      whereLogic = "AND",
      orderBy = [],
      limit,
      offset,
    } = options;

    // 验证列名
    const sanitizedColumns = columns.map((col) => {
      if (col === "*") return "*";
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(col)) {
        throw new Error(`Invalid column name: ${col}`);
      }
      return `"${col}"`;
    });

    // 构建 SQL 语句
    const columnClause = sanitizedColumns.join(", ");
    let sql = `SELECT ${columnClause} FROM "${table}"`;
    const allParams: unknown[] = [];

    // 添加 WHERE 子句
    if (where.length > 0) {
      const { whereClause, params } = buildWhereClause(where, whereLogic);
      sql += ` WHERE ${whereClause}`;
      allParams.push(...params);
    }

    // 添加 ORDER BY 子句
    if (orderBy.length > 0) {
      const orderClauses = orderBy.map(({ column, order = "ASC" }) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
          throw new Error(`Invalid column name in orderBy: ${column}`);
        }
        if (!["ASC", "DESC"].includes(order)) {
          throw new Error(`Invalid sort order: ${order}`);
        }
        return `"${column}" ${order}`;
      });
      sql += ` ORDER BY ${orderClauses.join(", ")}`;
    }

    // 添加 LIMIT 子句
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error(`Invalid limit value: ${limit}`);
      }
      sql += ` LIMIT ?`;
      allParams.push(limit);
    }

    // 添加 OFFSET 子句
    if (offset !== undefined) {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid offset value: ${offset}`);
      }
      sql += ` OFFSET ?`;
      allParams.push(offset);
    }

    return await query<T>(env, sql, allParams);
  } catch (error) {
    logger.error(
      {
        table,
        options,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive select failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during select operation");
  }
}

/**
 * 查询单条记录
 *
 * 执行 SELECT 查询并返回第一条记录，如果没有找到则返回 null。
 * 适用于根据唯一键（如 ID）查询单个实体的场景。
 *
 * @param env - Cloudflare Workers 环境对象
 * @param table - 表名
 * @param options - 查询选项
 * @returns Promise<T | null> 查询结果的第一条记录，或 null（如果未找到）
 *
 * @example
 * ```typescript
 * // 根据 ID 查询用户
 * const user = await first<User>(env, 'users', {
 *   where: [{ column: 'id', operator: '=', value: userId }]
 * });
 *
 * if (user) {
 *   console.log(`Found user: ${user.name}`);
 * } else {
 *   console.log('User not found');
 * }
 * ```
 */
export async function first<T = unknown>(
  env: HyperdriveEnv,
  table: string,
  options: SelectOptions = {}
): Promise<T | null> {
  try {
    // 强制限制为 1 条记录，优化查询性能
    const result = await select<T>(env, table, {
      ...options,
      limit: 1,
    });

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error(
      {
        table,
        options,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive first query failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during first operation");
  }
}

/**
 * 统计记录数量
 *
 * 执行 COUNT 查询并返回符合条件的记录数量。
 * 支持所有 SelectOptions 中的筛选条件，但忽略列选择、排序和分页。
 *
 * @param env - Cloudflare Workers 环境对象
 * @param table - 表名
 * @param options - 筛选条件（where、whereLogic）
 * @returns Promise<number> 符合条件的记录数量
 *
 * @example
 * ```typescript
 * // 统计活跃用户数量
 * const activeUserCount = await count(env, 'users', {
 *   where: [{ column: 'status', operator: '=', value: 'active' }]
 * });
 * console.log(`Total active users: ${activeUserCount}`);
 *
 * // 统计特定年龄段的用户数量
 * const teenCount = await count(env, 'users', {
 *   where: [
 *     { column: 'age', operator: '>=', value: 13 },
 *     { column: 'age', operator: '<', value: 20 }
 *   ]
 * });
 * ```
 */
export async function count(
  env: HyperdriveEnv,
  table: string,
  options: Omit<SelectOptions, "columns" | "orderBy" | "limit" | "offset"> = {}
): Promise<number> {
  try {
    if (!hasHyperdriveBinding(env)) {
      throw new Error("HYPERDRIVE binding is not available in the environment");
    }

    // 验证表名格式
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    const { where = [], whereLogic = "AND" } = options;

    // 构建 SQL 语句
    let sql = `SELECT COUNT(*) as count FROM "${table}"`;
    const params: unknown[] = [];

    // 添加 WHERE 子句
    if (where.length > 0) {
      const { whereClause, params: whereParams } = buildWhereClause(where, whereLogic);
      sql += ` WHERE ${whereClause}`;
      params.push(...whereParams);
    }

    const result = await query<{ count: number | string }>(env, sql, params);

    // COUNT 总是返回一行，count 字段可能是 number 或 string（取决于数据库驱动）
    if (result.rows.length === 0) {
      return 0;
    }

    const countValue = result.rows[0].count;
    return typeof countValue === "string" ? parseInt(countValue, 10) : countValue;
  } catch (error) {
    logger.error(
      {
        table,
        options,
        error: error instanceof Error ? error.message : String(error),
      },
      "Hyperdrive count failed"
    );
    throw error instanceof Error ? error : new Error("An unknown error occurred during count operation");
  }
}

/**
 * 批量查询（IN 查询）
 *
 * 便捷方法：查询字段值在指定数组中的所有记录。
 * 等同于 WHERE column IN (?, ?, ...)。
 *
 * @param env - Cloudflare Workers 环境对象
 * @param table - 表名
 * @param column - 要匹配的列名
 * @param values - 值数组
 * @param options - 其他查询选项
 * @returns Promise<QueryResult<T>> 查询结果
 *
 * @example
 * ```typescript
 * // 查询多个用户的信息
 * const users = await selectIn<User>(env, 'users', 'id', [1, 2, 3, 4, 5]);
 *
 * // 查询多个状态的文章
 * const articles = await selectIn<Article>(env, 'articles', 'status', ['published', 'draft'], {
 *   orderBy: [{ column: 'created_at', order: 'DESC' }]
 * });
 * ```
 */
export async function selectIn<T = unknown>(
  env: HyperdriveEnv,
  table: string,
  column: string,
  values: unknown[],
  options: Omit<SelectOptions, "where"> = {}
): Promise<QueryResult<T>> {
  if (!Array.isArray(values)) {
    throw new Error("Values must be an array");
  }

  if (values.length === 0) {
    // 空数组，直接返回空结果
    return { rows: [], rowCount: 0 };
  }

  return await select<T>(env, table, {
    ...options,
    where: [{ column, operator: "IN", value: values }],
  });
}

/**
 * 分页查询结果接口
 */
export interface PaginatedResult<T> extends QueryResult<T> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 分页查询
 *
 * 执行带分页的查询，返回当前页的数据和分页信息。
 * 会自动查询总数并计算分页元数据。
 *
 * @param env - Cloudflare Workers 环境对象
 * @param table - 表名
 * @param options - 查询选项（包括分页参数）
 * @returns Promise<PaginatedResult<T>> 分页查询结果
 *
 * @example
 * ```typescript
 * // 获取第 2 页的用户数据，每页 20 条
 * const paginatedUsers = await paginate<User>(env, 'users', {
 *   where: [{ column: 'status', operator: '=', value: 'active' }],
 *   orderBy: [{ column: 'created_at', order: 'DESC' }],
 *   page: 2,
 *   pageSize: 20
 * });
 *
 * console.log(`Total: ${paginatedUsers.total} users`);
 * console.log(`Page ${paginatedUsers.page} of ${paginatedUsers.totalPages}`);
 * console.log(`Current page users:`, paginatedUsers.rows);
 * ```
 */
export async function paginate<T = unknown>(
  env: HyperdriveEnv,
  table: string,
  options: SelectOptions & {
    page?: number;
    pageSize?: number;
  } = {}
): Promise<PaginatedResult<T>> {
  const { page = 1, pageSize = 10, ...selectOptions } = options;

  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`Invalid page number: ${page}. Page must be a positive integer.`);
  }

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`Invalid page size: ${pageSize}. Page size must be a positive integer.`);
  }

  // 计算偏移量
  const offset = (page - 1) * pageSize;

  // 并行执行查询和计数
  const [dataResult, total] = await Promise.all([
    select<T>(env, table, {
      ...selectOptions,
      limit: pageSize,
      offset,
    }),
    count(env, table, {
      where: selectOptions.where,
      whereLogic: selectOptions.whereLogic,
    }),
  ]);

  return {
    ...dataResult,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
