// play.js

importScripts("./mp4box.all.min.js");

// ====== MP4 Demuxer Implementation ======
class MP4FileSink {
  constructor(file, setStatus) {
    this.file = file;
    this.setStatus = setStatus;
    this.offset = 0;
    console.log("MP4FileSink initialized.");
  }

  write(chunk) {
    this.setStatus("fetch", `${(this.offset / (1024 ** 2)).toFixed(1)} MiB`);
    if (!chunk.fileStart) {
      chunk.fileStart = this.offset;
    }
    this.offset += chunk.byteLength;
    this.file.appendBuffer(chunk);
  }

  close() {
    console.log("MP4FileSink closing and flushing the file.");
    this.setStatus("fetch", "完成");
    this.file.flush();
  }
}

class MP4Demuxer {
  constructor(uri, { onConfig, onChunk, setStatus }) {
    this.onConfig = onConfig;
    this.onChunk = onChunk;
    this.setStatus = setStatus;

    console.log("MP4Demuxer initialized with URI:", uri);

    this.file = MP4Box.createFile();
    this.file.onError = error => {
      console.error("MP4Demuxer error:", error);
      this.setStatus("demux", error);
    };
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);

    this.fetchStream(uri);
  }

  fetchStream(uri) {
    fetch(uri).then(response => {
      if (!response.body) {
        throw new Error("ReadableStream not yet supported in this browser.");
      }
      const reader = response.body.getReader();
      const readChunk = ({ done, value }) => {
        if (done) {
          this.file.flush();
          return;
        }
        if (value) {
          const buffer = new ArrayBuffer(value.byteLength);
          new Uint8Array(buffer).set(value);
          buffer.fileStart = this.file.nextParsePosition;
          this.file.appendBuffer(buffer);
        }
        reader.read().then(readChunk);
      };
      reader.read().then(readChunk);
    }).catch(error => {
      console.error("MP4Demuxer fetch error:", error);
      this.setStatus("fetch", error.message || error);
    });
  }

  onReady(info) {
    console.log("MP4Demuxer ready with info:", info);
    this.setStatus("demux", "准备就绪");
    const track = info.videoTracks[0];
    if (!track) {
      this.setStatus("demux", "未找到视频轨道");
      return;
    }

    const config = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedHeight: track.video.height,
      codedWidth: track.video.width,
      description: this.getDescription(track),
    };
    this.onConfig(config);
    this.file.setExtractionOptions(track.id);
    this.file.start();
  }

  onSamples(track_id, ref, samples) {
    for (const sample of samples) {
      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: (sample.cts * 1e6) / sample.timescale,
        duration: (sample.duration * 1e6) / sample.timescale,
        data: sample.data
      });
      this.onChunk(chunk);
    }
  }

  getDescription(track) {
    console.log("Fetching description for track ID:", track.id);
    const trak = this.file.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        if (typeof DataStream === 'undefined') {
          throw new Error("DataStream class is not available.");
        }
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
    throw new Error("avcC, hvcC, vpcC, or av1C box not found");
  }
}

// ====== 2D Renderer Implementation ======
class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  draw(frame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
    frame.close();
  }
}

// ====== Frame Timing and Rendering Mechanism ======
let rendererInstance = null;
let frameQueue = [];
let isPlaying = false;
let currentTime = 0;

function handleOutput(frame) {
  frameQueue.push(frame);
  processFrames();
}

function processFrames() {
  if (!rendererInstance || !isPlaying) return;

  while (frameQueue.length > 0) {
    const frame = frameQueue[0];
    const frameTime = frame.timestamp / 1e6;

    if (frameTime <= currentTime + 0.05) {
      frameQueue.shift();
      rendererInstance.draw(frame);
    } else {
      break;
    }
  }
}

function start({ type, dataUri, rendererName, canvas }) {
  if (type === 'start') {
    if (rendererName === "2d") {
      rendererInstance = new Canvas2DRenderer(canvas);
    } else {
      rendererInstance = new Canvas2DRenderer(canvas);
    }

    const decoder = new VideoDecoder({
      output: handleOutput,
      error(e) {
        console.error("Decoder error:", e);
      }
    });

    try {
      const demuxer = new MP4Demuxer(dataUri, {
        onConfig(config) {
          console.log("Decoder configured with codec:", config.codec);
          decoder.configure(config);
        },
        onChunk(chunk) {
          decoder.decode(chunk);
        },
        setStatus: (type, message) => {
          console.log(`${type}: ${message}`);
        }
      });
    } catch (error) {
      console.error("Demuxer initialization error:", error);
    }
  }
}

function play() {
  if (!isPlaying) {
    isPlaying = true;
    console.log("Playback started.");
    processFrames();
  }
}

function pause() {
  if (isPlaying) {
    isPlaying = false;
    console.log("Playback paused.");
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  switch (data.type) {
    case 'start':
      start(data);
      break;
    case 'play':
      play();
      break;
    case 'pause':
      pause();
      break;
    case 'timeUpdate':
      currentTime = data.currentTime;
      processFrames();
      break;
  }
}, { passive: true });

