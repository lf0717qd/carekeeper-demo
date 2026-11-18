(function () {
  var host = location.hostname;
  var local = host === "127.0.0.1" || host === "localhost";
  window.CAREKEEPER_CONFIG = {
    // 本地 server.py 用相对路径；GitHub Pages 走临时公网后端。
    // 隧道关闭后会自动回退静态演示。
    apiBase: local ? "" : "https://69e2d5143b6137ed-120-231-232-31.serveousercontent.com"
  };
})();
