(function () {
  var host = location.hostname;
  var local = host === "127.0.0.1" || host === "localhost";
  window.CAREKEEPER_CONFIG = {
    // 本地 server.py 用相对路径；GitHub Pages 走阿里云函数计算 FC。
    apiBase: local ? "" : "https://carekeeper-api-fvxlqjiadh.cn-hangzhou.fcapp.run"
  };
})();
