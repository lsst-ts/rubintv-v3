import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // dist (build output) and .vite (Vite's prebundled-dependency cache) are
  // generated artifacts, not source — linting them floods the report with
  // thousands of irrelevant problems from bundled third-party code. api-types
  // is generated from the OpenAPI schema.
  { ignores: ["dist", ".vite", "src/lib/api-types.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
