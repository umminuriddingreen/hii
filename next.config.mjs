/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  images: { unoptimized: true },
  typescript: {
    tsconfigPath: './tsconfig.json'
  }
};

export default nextConfig;
