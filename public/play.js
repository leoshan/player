// play.js

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
        return reader.read().then(readChunk);
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

    console.log("Track codec:", track.codec); // 确认 codec 字符串

    const config = {
      codec: track.codec, // 确保是完整的 codec 字符串，例如 'avc1.4d401e'
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
        timestamp: (sample.cts * 1e6) / sample.timescale, // 转换为微秒
        duration: (sample.duration * 1e6) / sample.timescale, // 转换为微秒
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
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        const description = new Uint8Array(stream.buffer, 8); // 移除盒子头部（前8字节）
        console.log("Description length:", description.length);
        console.log("Description data:", description);
        return description;
      }
    }
    throw new Error("avcC, hvcC, vpcC, or av1C box not found");
  }
}

// ====== Worker 脚本 ======
let decoder = null;
let isPlaying = false;
let frameBuffer = []; // 帧缓冲区
const FRAME_BUFFER_TARGET_SIZE = 5; // 目标缓冲区大小

async function handleOutput(frame) {
  // 将解码后的帧添加到缓冲区
  frameBuffer.push(frame);
  // 通知主线程有新帧可用
  self.postMessage({ type: 'frame_available' });
}

async function start({ type, dataUri }) {
  if (type === 'start') {
    decoder = new VideoDecoder({
      output: handleOutput,
      error(e) {
        console.error("Decoder error:", e.message || e);
      }
    });

    try {
      const demuxer = new MP4Demuxer(dataUri, {
        onConfig: async (config) => {
          console.log("Decoder configured with codec:", config.codec);
          // 检查配置是否被支持
          try {
            const support = await VideoDecoder.isConfigSupported({
              codec: config.codec,
              codedWidth: config.codedWidth,
              codedHeight: config.codedHeight,
              description: config.description
            });
            console.log("Support check result:", support);
            if (support.supported) {
              decoder.configure({
                codec: config.codec,
                codedWidth: config.codedWidth,
                codedHeight: config.codedHeight,
                description: config.description
              });
              self.postMessage({
                type: 'config',
                config: config
              });
            } else {
              console.error(`Codec ${config.codec} is not supported.`);
            }
          } catch (error) {
            console.error("Error checking codec support:", error);
          }
        },
        onChunk(chunk) {
          if (decoder.state === "configured" && decoder.decodeQueueSize < FRAME_BUFFER_TARGET_SIZE) {
            try {
              decoder.decode(chunk);
            } catch (e) {
              console.error("Error decoding chunk:", e);
            }
          } else {
            // 解码器队列已满或未配置，稍后再试
            setTimeout(() => {
              this.onChunk(chunk);
            }, 10);
          }
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
    // 开始填充帧缓冲区
    fillFrameBuffer();
  }
}

function pause() {
  if (isPlaying) {
    isPlaying = false;
    console.log("Playback paused.");
  }
}

function fillFrameBuffer() {
  if (!isPlaying) return;

  // 如果帧缓冲区未满且解码器队列未满，则继续解码
  if (frameBuffer.length < FRAME_BUFFER_TARGET_SIZE && decoder.decodeQueueSize < FRAME_BUFFER_TARGET_SIZE) {
    // 此处不需要额外操作，解码器会继续处理
  }

  // 定时检查缓冲区状态
  setTimeout(fillFrameBuffer, 100);
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
    case 'request_frame':
      sendFrameToMainThread(data.currentTime);
      break;
  }
}, { passive: true });

// 新增函数：根据当前时间发送最合适的帧到主线程
function sendFrameToMainThread(currentTime) {
  if (frameBuffer.length === 0) return;

  // 查找最接近当前时间的帧
  let bestFrameIndex = -1;
  let minTimeDelta = Infinity;

  for (let i = 0; i < frameBuffer.length; i++) {
    const frame = frameBuffer[i];
    const frameTime = frame.timestamp / 1e6; // 转换为秒
    const timeDelta = Math.abs(frameTime - currentTime);

    if (timeDelta < minTimeDelta) {
      minTimeDelta = timeDelta;
      bestFrameIndex = i;
    } else {
      break;
    }
  }

  if (bestFrameIndex !== -1) {
    const frame = frameBuffer.splice(bestFrameIndex, 1)[0]; // 从缓冲区中移除帧
    // 将 VideoFrame 转换为 ImageBitmap 并发送到主线程
    createImageBitmap(frame).then((imageBitmap) => {
      frame.close(); // 释放 VideoFrame 资源
      self.postMessage({
        type: 'frame',
        timestamp: frame.timestamp,
        imageBitmap: imageBitmap
      }, [imageBitmap]);
    }).catch((error) => {
      console.error("Error creating ImageBitmap:", error);
    });
  }

  // 清理过期的帧并关闭它们
  frameBuffer = frameBuffer.filter(frame => {
    const frameTime = frame.timestamp / 1e6;
    if (frameTime >= currentTime) {
      return true;
    } else {
      frame.close(); // 关闭过期的帧
      return false;
    }
  });
}
