const https = require('https'), // 使用https模块替代http模块
    url = require("url"),
    path = require("path"),
    fs = require("fs"),
    port = process.argv[2] || 8443, // 默认端口改为8443
    mimeTypes = {
      "html": "text/html",
      "jpeg": "image/jpeg",
      "jpg": "image/jpeg",
      "png": "image/png",
      "js": "text/javascript",
      "wasm": "application/wasm",
      "css": "text/css"
    };

// 加载SSL证书和私钥
const options = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'shanpengpeng.cn.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'shanpengpeng.cn.pem'))
};

const serverPort = parseInt(port, 10);

https.createServer(options, function(request, response) { // 使用https.createServer并传入SSL选项
  var uri = url.parse(request.url).pathname,
    filename = path.join(process.cwd(), uri);

  fs.exists(filename, function(exists) {
    if(!exists) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.write("404 Not Found\n");
      response.end();
      return;
    }

    if (fs.statSync(filename).isDirectory()) {
      if (filename[filename.length-1] != '/') {
        filename += '/';
      }
      filename += 'index.html';
    }

    fs.readFile(filename, "binary", function(err, file) {
      if(err) {
        response.writeHead(500, {"Content-Type": "text/plain", "Cross-Origin-Opener-Policy": "same-origin unsafe-allow-outgoing"});
        response.write(err + "\n");
        response.end();
        return;
      }

      var mimeType = mimeTypes[filename.split('.').pop()];

      if (!mimeType) {
        mimeType = 'text/plain';
      }

      console.log("serving " + filename);

      response.writeHead(200, { 
        "Content-Type": mimeType,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp" 
      });
      response.write(file, "binary");
      response.end();
    });
  });

// 这个服务器不安全。仅监听所有网络接口上的连接。
}).listen(serverPort, '0.0.0.0'); // 更改监听地址为0.0.0.0

console.log("Static file server running at\n  => https://0.0.0.0:" + port + "/\nCTRL + C to shutdown");

