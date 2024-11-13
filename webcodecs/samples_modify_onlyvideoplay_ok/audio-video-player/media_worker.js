// The "media worker" houses and drives the VideoRenderer class to perform demuxing and decoder I/O on a background worker thread.
console.info(`Worker started`);

// Import mp4box.js and video_renderer.js
importScripts('../third_party/mp4boxjs/mp4box.all.min.js');
let moduleLoadedResolver = null;
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver));
let playing = false;
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
    default:
      console.error(`Worker bad message: ${e.data}`);
  }

});
