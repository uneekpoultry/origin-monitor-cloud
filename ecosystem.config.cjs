module.exports = {
  apps: [
    {
      name: "origin-portal",
      cwd: "/srv/origin-monitor/portal",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      max_memory_restart: "500M",
      instances: 1,
      autorestart: true,
    },
    {
      name: "origin-api",
      cwd: "/srv/origin-monitor/api",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: "4000",
      },
      max_memory_restart: "300M",
      instances: 1,
      autorestart: true,
    },
  ],
};
