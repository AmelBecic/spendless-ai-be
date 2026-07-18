import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration specs share one Postgres and TRUNCATE it between tests. Run
    // test files sequentially so one file's reset can't wipe another's rows
    // mid-assertion. The suite is small, so the cost is negligible.
    fileParallelism: false,
  },
});
