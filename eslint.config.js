import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// A minimal configuration that detects only the ways of writing that lead to actual bugs and that the type check (tsc) does not find.
// Looks and matters of taste (formatting, etc.) are not handled.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "tmp/**", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Arguments/variables starting with `_` are allowed as "intentionally unused" (e.g. arguments overridden in subclasses)
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
