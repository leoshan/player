// media_worker.js

console.info(`Worker started`);

// Import mp4box.js and video_renderer.js
importScripts('../third_party/mp4boxjs/mp4box.all.min.js');
let moduleLoadedResolver = null;
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver));
let playing = false;
let videoRenderer = null;
let canvas = null;

(async () => {
    let videoImport = import('../lib/video_renderer.js');
    videoImport.then((module) => {
      videoRenderer = new module.VideoRenderer();
      moduleLoadedResolver();
      moduleLoadedResolver = null;
      console.info('Worker modules imported');
    })
})();

self.addEventListener('message', async function(e) {
  await modulesReady;

  console.info(`Worker message: ${JSON.stringify(e.data)}`);

  switch (e.data.command) {
    case 'setupCanvas':
      canvas = e.data.canvas;
      break;
    case 'initialize':
      if (videoRenderer.initialized) {
        // 如果已经初始化，先关闭之前的解码器
        videoRenderer.reset();
      }

      let demuxerModule = await import('./mp4_pull_demuxer.js');

      let videoDemuxer = new demuxerModule.MP4PullDemuxer(e.data.videoFile);
      await videoRenderer.initialize(videoDemuxer, canvas);
      postMessage({command: 'initialize-done'});
      break;
    case 'play':
      playing = true;
      let mediaStartTime = performance.now();

      self.requestAnimationFrame(function renderVideo() {
        if (!playing)
          return;
        let mediaTimeUs = (performance.now() - mediaStartTime) * 1000; // in microseconds
        videoRenderer.render(mediaTimeUs);
        self.requestAnimationFrame(renderVideo);
      });
      break;
    case 'pause':
      playing = false;
      break;
    case 'seek':
      // 如果需要实现 seek 功能，需要在这里添加处理逻辑
      console.warn('Seek command received but not implemented.');
      break;
    default:
      console.error(`Worker received unknown command: ${e.data.command}`);
  }

});

