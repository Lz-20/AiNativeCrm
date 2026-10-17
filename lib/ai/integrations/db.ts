import type { Pool, QueryConfig, QueryResultRow } from "pg";

/** Optional integrations must not hold a completed CRM action behind a hung pool. */
export async function integrationQuery<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
) {
  const query: QueryConfig & { query_timeout: number } = { text, values, query_timeout: 1500 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pool.query<T>(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("integration_db_timeout")), 1800);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
