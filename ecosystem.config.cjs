module.exports = {
  apps: [
    {
      name: 'flutter-ssl-patch',
      script: 'server.js',
      cwd: '/home/user/webapp',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '/home/user/webapp/logs/err.log',
      out_file:   '/home/user/webapp/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
