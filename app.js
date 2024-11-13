const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors'); // 引入 cors 中间件
const path = require('path');

const app = express();

// 配置 CORS
app.use(cors());

// 设置 public 目录为静态文件目录
app.use(express.static(path.join(__dirname, 'public')));

// Load SSL certificate and private key
const options = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'shanpengpeng.cn.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'shanpengpeng.cn.pem'))
};

// Set up a basic route
app.get('/', (req, res) => {
    res.send('Hello, HTTPS world with your own SSL certificate!');
});

// Start HTTPS server on 0.0.0.0 to listen on all available network interfaces
https.createServer(options, app).listen(8443, '0.0.0.0', () => {
    console.log('HTTPS Server running on 0.0.0.0:8443');
});

