(function () {
  var host = location.hostname;
  var local = host === "127.0.0.1" || host === "localhost";
  window.CAREKEEPER_CONFIG = {
    // 本地 server.py 用相对路径；GitHub Pages 走临时公网后端。
    // 隧道关闭后会自动回退静态演示。
    apiBase: local ? "" : "https://carekeeper-demo.loca.lt"
  };
})();
