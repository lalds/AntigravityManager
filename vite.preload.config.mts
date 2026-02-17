import { defineConfig, loadEnv } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      // Disabled Sentry to prevent build errors
      // sentryVitePlugin({
      //   org: process.env.SENTRY_ORG || env.SENTRY_ORG,
      //   project: process.env.SENTRY_PROJECT || env.SENTRY_PROJECT,
      //   authToken: process.env.SENTRY_AUTH_TOKEN || env.SENTRY_AUTH_TOKEN,
      //   release: {
      //     name: `${process.env.npm_package_name}@${process.env.npm_package_version}`,
      //   },
      // }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), './src'),
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ['better-sqlite3', 'keytar'],
      },
    },
  };
});
