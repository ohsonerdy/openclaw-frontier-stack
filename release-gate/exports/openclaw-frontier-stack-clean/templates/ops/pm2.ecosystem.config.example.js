'use strict';

module.exports = {
  apps: [
    {
      name: '@openclaw-frontier/signed-bus-listener',
      script: './src/signed-bus/examples/listener.js',
      cwd: '/opt/openclaw-frontier-stack',
      env: {
        NODE_ENV: 'production',
        OPENCLAW_FRONTIER_ENV_FILE: '/etc/orchestrator-frontier/signed-bus.env',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      out_file: '/var/log/orchestrator-frontier/signed-bus-listener.out.log',
      error_file: '/var/log/orchestrator-frontier/signed-bus-listener.err.log',
      time: true,
    },
  ],
};
