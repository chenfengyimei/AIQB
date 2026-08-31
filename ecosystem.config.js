'use strict';

const root = __dirname;
const dataDir = process.env.AIQB_DATA_DIR || root + '/server/data';
const webPort = Number(process.env.AIQB_PORT || 3001);
const collectorPort = Number(process.env.AIQB_COLLECTOR_PORT || (webPort + 1));
const common = {
  cwd: root,
  script: 'server/server.js',
  time: true,
  max_memory_restart: '650M',
  kill_timeout: 10000,
  listen_timeout: 10000,
  wait_ready: false,
  env: {
    NODE_ENV: 'production',
    AIQB_DATA_DIR: dataDir,
    AIQB_ENDPOINT_PRESET: process.env.AIQB_ENDPOINT_PRESET || 'community',
    AIQB_UPSTREAM_BASE_URL: process.env.AIQB_UPSTREAM_BASE_URL || 'https://upstream.invalid',
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'aiqb-web',
      exec_mode: 'cluster',
      instances: 2,
      env: {
        ...common.env,
        AIQB_PORT: webPort,
        AIQB_ROLE: 'web',
        AIQB_DISABLE_COLLECT: '1',
        AIQB_BENCHMARK_TOKEN: process.env.AIQB_BENCHMARK_TOKEN || '',
        AIQB_UPDATE_BRANCH: process.env.AIQB_UPDATE_BRANCH || 'master',
        AIQB_UPDATE_GITHUB_REPO: process.env.AIQB_UPDATE_GITHUB_REPO || 'chenfengyimei/AIQB',
        AIQB_UPDATE_GITHUB_TOKEN: process.env.AIQB_UPDATE_GITHUB_TOKEN || '',
        AIQB_UPDATE_GITEE_REPO: process.env.AIQB_UPDATE_GITEE_REPO || 'chenfengloveyuri/aiqb',
        AIQB_UPDATE_GITEE_TOKEN: process.env.AIQB_UPDATE_GITEE_TOKEN || '',
      },
    },
    {
      ...common,
      name: 'aiqb-collector',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      env: {
        ...common.env,
        AIQB_PORT: collectorPort,
        AIQB_ROLE: 'collector',
        AIQB_BENCHMARK_TOKEN: process.env.AIQB_BENCHMARK_TOKEN || '',
      },
    },
  ],
};
