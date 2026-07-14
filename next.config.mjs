/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.HII_TAURI === '1' ? 'standalone' : undefined,
  experimental: {
    // allow large audio files through Server Actions
    serverActions: { bodySizeLimit: '200mb' }
  }
};

export default nextConfig;
