/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The arcade lives in /public/game.html and is mounted in an iframe.
  // Browsers cache iframe documents aggressively — a normal refresh often will
  // NOT re-fetch them, so a fresh deploy can keep showing the old game.
  // Force a revalidation on every load. The file is ~190KB and gzips well, so
  // the cost is negligible next to a booth screen showing stale content.
  async headers() {
    return [
      {
        source: '/game.html',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
