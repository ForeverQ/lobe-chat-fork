import { type NextConfig } from 'next';

import { defineConfig } from './src/libs/next/config/define-config';

const isVercel = !!process.env.VERCEL_ENV;

const vercelConfig: Pick<NextConfig, 'experimental' | 'outputFileTracingExcludes' | 'webpack'> = {
  // Vercel serverless optimization: exclude musl binaries from all routes
  // Vercel uses Amazon Linux (glibc), not Alpine Linux (musl)
  // This saves ~45MB (29MB canvas-musl + 16MB sharp-musl) per serverless function
  outputFileTracingExcludes: {
    '*': [
      'node_modules/.pnpm/@napi-rs+canvas-*-musl*',
      'node_modules/.pnpm/@img+sharp-libvips-*musl*',
      // Exclude SPA/desktop/mobile build artifacts from serverless functions
      'public/_spa/**',
      'dist/desktop/**',
      'dist/mobile/**',
      'apps/desktop/**',
      'packages/database/migrations/**',
    ],
  },
  // Disable webpack build worker on Vercel (2 cores / 8 GB) to avoid OOM:
  // forked worker doubles memory pressure while bringing little speedup on 2 cores.
  experimental: {
    webpackBuildWorker: false,
  },
  webpack(config) {
    // Vercel Hobby builders have limited RAM; serializing webpack's filesystem
    // cache can OOM this app near the end of `next build`.
    config.cache = false;

    return config;
  },
};
const nextConfig = defineConfig({
  ...(isVercel ? vercelConfig : {}),
});

export default nextConfig;
