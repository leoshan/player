importScripts("./mp4box.all.min.js");

// ====== MP4 Demuxer Implementation ======
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
      postMessage({ type: 'error', content: error.message || error });
    };
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);

    this.offset = 0; // 初始化文件偏移量
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
          // 创建独立的 ArrayBuffer
          const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          buffer.fileStart = this.offset; // 设置 fileStart
          this.offset += value.byteLength; // 更新偏移量
          this.file.appendBuffer(buffer);
        }
        reader.read().then(readChunk);
      };
      reader.read().then(readChunk);
    }).catch(error => {
      console.error("MP4Demuxer fetch error:", error);
      this.setStatus("fetch", error.message || error);
      postMessage({ type: 'error', content: error.message || error });
    });
  }

  onReady(info) {
    console.log("MP4Demuxer ready with info:", info);
    this.setStatus("demux", "准备就绪");
    const track = info.videoTracks[0];
    if (!track) {
      this.setStatus("demux", "未找到视频轨道");
      postMessage({ type: 'error', content: "未找到视频轨道" });
      return;
    }

    const config = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedHeight: track.video.height,
      codedWidth: track.video.width,
      description: this.getDescription(track),
    };
    if (!config.description) {
      console.error("Failed to get track description. Decoder may fail to initialize properly.");
      this.setStatus("demux", "无法获取视频描述信息");
      postMessage({ type: 'error', content: "无法获取视频描述信息" });
      return; // 终止进一步处理
    }
    this.onConfig(config);
    this.file.setExtractionOptions(track.id);
    this.file.start();
  }

  onSamples(track_id, ref, samples) {
    for (const sample of samples) {
      if (!sample.data || sample.data.byteLength === 0) {
        console.error("Sample data is null or empty, skipping frame.");
        continue;
      }
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
    if (!trak) {
      console.error("No track found with ID:", track.id);
      return null;
    }

    // 优先使用 codec_private 数据
    if (trak.codec_private) {
      console.log("Using codec_private data for description.");
      // 确保 codec_private 至少有 8 字节（box 头部）
      if (trak.codec_private.length <= 8) {
        console.error("codec_private data is too short.");
        return null;
      }
      // 去除前8字节的box头部
      const description = new Uint8Array(trak.codec_private.slice(8));
      console.log("Description length (codec_private):", description.length);
      console.log("Description (codec_private, first 16 bytes):", description.slice(0, 16));
      return description;
    }

    // 如果 codec_private 不存在，尝试解析 avcC box
    if (typeof DataStream === 'undefined') {
      throw new Error("DataStream class is not available. Ensure mp4box.all.min.js is correctly loaded.");
    }

    if (!trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl || !trak.mdia.minf.stbl.stsd) {
      console.error("Track structure incomplete, cannot get description.");
      return null;
    }

    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        // 去除前8字节的box头部
        const description = new Uint8Array(stream.buffer.slice(8));
        console.log("Description length (avcC box):", description.length);
        console.log("Description (avcC box, first 16 bytes):", description.slice(0, 16));
        return description;
      }
    }
    console.error("avcC, hvcC, vpcC, or av1C box not found, description is null.");
    return null;
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

    if (frameTime <= currentTime + 0.1) { // 增加同步的缓冲时间，减少跳帧现象
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
      rendererInstance = new Canvas2DRenderer(canvas); // 预留扩展其他渲染器的可能性
    }

    const decoder = new VideoDecoder({
      output: handleOutput,
      error(e) {
        console.error("Decoder error:", e);
        postMessage({ type: 'error', content: e.message || e });
      }
    });

    try {
      const demuxer = new MP4Demuxer(dataUri, {
        onConfig: (config) => { // 使用箭头函数确保 'decoder' 在作用域内
          console.log("Decoder configured with codec:", config.codec);
          console.log("Description length:", config.description.length);
          console.log("Description (first 16 bytes):", config.description.slice(0, 16));
          decoder.configure(config);
        },
        onChunk: (chunk) => { // 使用箭头函数确保 'decoder' 在作用域内
          if (chunk.type === "key" || decoder.decodeQueueSize < 5) {
            // 优化逻辑：确保关键帧解码，并增加队列检查，尽量避免跳帧
            console.log("Decoding chunk:", chunk.type);
            decoder.decode(chunk).catch(error => { // 确保 'decoder.decode(chunk)' 返回 Promise
              console.error("Decoder decode error:", error);
              postMessage({ type: 'error', content: error.message || error });
            });
          } else {
            console.warn("Skipped non-key frame to maintain buffer stability.");
          }
        },
        setStatus: (type, message) => {
          console.log(`${type}: ${message}`);
          postMessage({ type: 'status', content: `${type}: ${message}` });
        }
      });
    } catch (error) {
      console.error("Demuxer initialization error:", error);
      postMessage({ type: 'error', content: error.message || error });
    }
  }
}

function play() {
  if (!isPlaying) {
    isPlaying = true;
    console.log("Playback started.");
    processFrames();
    postMessage({ type: 'status', content: '播放开始' });
  }
}

function pause() {
  if (isPlaying) {
    isPlaying = false;
    console.log("Playback paused.");
    postMessage({ type: 'status', content: '播放暂停' });
  }
}

function seek(time) {
  console.log(`Seeking to time: ${time} seconds`);
  currentTime = time;
  frameQueue = []; // 清空帧队列，确保同步
  if (rendererInstance) {
    processFrames(); // 更新画面
  }
  postMessage({ type: 'status', content: `已跳转到 ${time} 秒` });
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
    case 'seek':
      seek(data.time);
      break;
    default:
      console.warn("Unknown message type:", data.type);
  }
}, { passive: true });

