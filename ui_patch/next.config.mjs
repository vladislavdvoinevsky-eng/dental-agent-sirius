/** @type {import('next').NextConfig} */
const nextConfig = {
  // адрес этого ПК в сети, чтобы другие команды могли открыть чат (задаёт run.bat)
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS || "").split(",").filter(Boolean),
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
