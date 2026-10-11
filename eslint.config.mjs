import tseslint from "@electron-toolkit/eslint-config-ts";
import eslintPluginSvelte from "eslint-plugin-svelte";
import { defineConfig } from "eslint/config";

export default defineConfig(
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/out",
      "**/.venv/**",
      "nicegal-server",
      "src/shared/paraglide",
      "projects",
    ],
  },
  tseslint.configs.recommended,
  eslintPluginSvelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ["**/*.{tsx,svelte}"],
    rules: {
      "svelte/no-unused-svelte-ignore": "off",
    },
  },
);
