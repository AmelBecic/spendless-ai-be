// ESLint flat config (ESLint 9+). Minimal, TypeScript-aware.
// Install: npm i -D eslint typescript-eslint
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".next/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // The isolation seam (SLAI-7), enforced rather than merely documented: a route
    // handler that reaches for Prisma is a handler that can forget the `userId`
    // filter. Data access belongs in src/repositories/, whose every method is
    // user-scoped by construction. Type-only imports stay allowed — they cannot
    // issue a query.
    files: ["src/routes/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              allowTypeImports: true,
              message:
                "Route handlers must not query Prisma directly — use a repository from src/repositories/ (every method is scoped to a userId).",
            },
          ],
          patterns: [
            {
              group: ["**/db/client", "**/db/client.js"],
              allowTypeImports: true,
              message:
                "Route handlers must not query Prisma directly — use a repository from src/repositories/ (every method is scoped to a userId).",
            },
          ],
        },
      ],
    },
  },
);
