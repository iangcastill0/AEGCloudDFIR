/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Linting is run via `pnpm --filter @aeg-clouddfir/web lint`, which reuses
  // the monorepo root eslint.config.mjs; next build only typechecks.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
