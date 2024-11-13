// The "media worker" houses and drives the VideoRenderer class to perform demuxing and decoder I/O on a background worker thread.
console.info(`Worker started`);

importScripts('../third_party/mp4boxjs/mp4box.all.min.js');

let moduleLoadedResolver = null;
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver));
let playing = false;
let videoRenderer = null;
let lastMediaTimeSecs = 0;
let lastMediaTimeCapturePoint = 0;

(async () => {
    let videoImport = import('../lib/video_renderer.js');
    videoImport.then((module) => {
      videoRenderer = new module.VideoRenderer();
      moduleLoadedResolver();
      moduleLoadedResolver = null;
      console.info('Worker module imported');
    });
})();

function updateMediaTime(mediaTimeSecs, capturedAtHighResTimestamp) {
  lastMediaTimeSecs = mediaTimeSecs;
  lastMediaTimeCapturePoint = capturedAtHighResTimestamp - performance.timeOrigin;
}

function getMediaTimeMicroSeconds() {
  let msecsSinceCapture = performance.now() - lastMediaTimeCapturePoint;
  return ((lastMediaTimeSecs * 1000) + msecsSinceCapture) * 1000;
}

self.addEventListener('message', async function(e) {
  await modulesReady;

  console.info(`Worker message: ${JSON.stringify(e.data)}`);

  switch (e.data.command) {
    case 'initialize':
      let demuxerModule = await import('./mp4_pull_demuxer.js');
      let videoDemuxer = new demuxerModule.MP4PullDemuxer(e.data.videoFile);
      let videoReady = videoRenderer.initialize(videoDemuxer, e.data.canvas);
      await videoReady;
      postMessage({command: 'initialize-done'});
      break;

    case 'play':
      playing = true;
      updateMediaTime(e.data.mediaTimeSecs, e.data.mediaTimeCapturedAtHighResTimestamp);

      self.requestAnimationFrame(function renderVideo() {
        if (!playing) return;
        videoRenderer.render(getMediaTimeMicroSeconds());
        self.requestAnimationFrame(renderVideo);
      });
      break;

    case 'pause':
      playing = false;
      break;

    case 'update-media-time':
      updateMediaTime(e.data.mediaTimeSecs, e.data.mediaTimeCapturedAtHighResTimestamp);
      break;

    default:
      console.error(`Worker bad message: ${e.data}`);
  }
});
