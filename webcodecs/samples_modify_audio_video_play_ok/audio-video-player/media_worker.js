// The "media worker" houses and drives the VideoRenderer class to perform demuxing and decoder I/O on a background worker thread.
console.info(`Worker started`);

// Import mp4box.js and video_renderer.js
importScripts('../third_party/mp4boxjs/mp4box.all.min.js');
let moduleLoadedResolver = null;
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver));
let videoRenderer = null;

(async () => {
    let videoImport = import('../lib/video_renderer.js');
    videoImport.then((module) => {
      videoRenderer = new module.VideoRenderer();
      moduleLoadedResolver();
      moduleLoadedResolver = null;
      console.info('Worker modules imported');
    })
})();

// 当前播放时间（微秒）
let currentPlaybackTime = 0;

// 处理消息事件
self.addEventListener('message', async function(e) {
  await modulesReady;

  console.info(`Worker message: ${JSON.stringify(e.data)}`);

  switch (e.data.command) {
    case 'initialize':
      let demuxerModule = await import('./mp4_pull_demuxer.js');

      let videoDemuxer = new demuxerModule.MP4PullDemuxer(e.data.videoFile);
      await videoRenderer.initialize(videoDemuxer, e.data.canvas);
      postMessage({command: 'initialize-done'});
      break;

    case 'play':
      // 开始渲染视频
      startVideoRendering();
      break;

    case 'pause':
      // 停止渲染视频
      stopVideoRendering();
      break;

    case 'seek':
      // 更新当前播放时间
      currentPlaybackTime = e.data.currentTime * 1000000; // 转换为微秒
      break;

    default:
      console.error(`Worker bad message: ${e.data}`);
  }

});

// 渲染控制
let rendering = false;

function startVideoRendering() {
  if (rendering) return;
  rendering = true;
  renderFrame();
}

function stopVideoRendering() {
  rendering = false;
}

function renderFrame() {
  if (!rendering) return;

  // 使用当前播放时间渲染视频帧
  videoRenderer.render(currentPlaybackTime);

  // 请求下一帧渲染
  setTimeout(renderFrame, 16); // 大约60fps
}
