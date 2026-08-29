/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.HII_NEXT_DIST_DIR || '.next',
  output: 'export',
  images: { unoptimized: true },
  typescript: {
    tsconfigPath: './tsconfig.json'
  }
};

export default nextConfig;
