import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloud Functions: a separate package with its own tsconfig, build and
    // dependencies, installed on its own. The app's build never installs
    // functions/node_modules, so linting or type-checking it from here would
    // fail on imports only that package can resolve.
    "functions/**",
  ]),
]);

export default eslintConfig;
