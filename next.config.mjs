/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // allow large audio files through Server Actions
    serverActions: { bodySizeLimit: '200mb' }
  }
};

export default nextConfig;
