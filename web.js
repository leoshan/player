const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');

const app = express();
app.use(cors()); // 启用 CORS 支持
app.use(express.json()); // 解析 JSON 请求体

// 提供 public 目录中的静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 设置日志文件
const logStream = fs.createWriteStream(path.join(__dirname, 'tesla_logs.txt'), { flags: 'a' });

// 使用 morgan 记录所有请求
app.use(morgan('combined', { stream: logStream }));

// 接收客户端发送的日志
app.post('/log', (req, res) => {
    const logData = req.body;
    fs.appendFile('browser_logs.txt', JSON.stringify(logData) + '\n', (err) => {
        if (err) throw err;
    });
    res.sendStatus(200); // 响应成功状态
});

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html')); // 返回前端页面
});

// 启动服务器监听所有接口
app.listen(3000, '0.0.0.0', () => {
    console.log('Server is running on http://0.0.0.0:3000');
});

