import {PullDemuxerBase, VIDEO_STREAM_TYPE} from '../lib/pull_demuxer_base.js'

const ENABLE_DEBUG_LOGGING = false;

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }
  console.debug(msg);
}

// Wrapper around MP4Box.js that shims pull-based demuxing on top their
// push-based API.
export class MP4PullDemuxer extends PullDemuxerBase {
  constructor(fileUri) {
    super();
    this.fileUri = fileUri;
  }

  async initialize() {
    this.source = new MP4Source(this.fileUri);
    this.readySamples = [];
    this._pending_read_resolver = null;

    await this._tracksReady();

    this._selectTrack(this.videoTrack);
  }

  getDecoderConfig() {
    return {
      // Browser doesn't support parsing full vp8 codec (eg: `vp08.00.41.08`),
      // they only support `vp8`.
      codec: this.videoTrack.codec.startsWith('vp08') ? 'vp8' : this.videoTrack.codec,
      displayWidth: this.videoTrack.track_width,
      displayHeight: this.videoTrack.track_height,
      description: this._getDescription(this.source.getDescriptionBox())
    }
  }

  async getNextChunk() {
    let sample = await this._readSample();
    const type = sample.is_sync ? "key" : "delta";
    const pts_us = (sample.cts * 1000000) / sample.timescale;
    const duration_us = (sample.duration * 1000000) / sample.timescale;
    return new EncodedVideoChunk({
      type: type,
      timestamp: pts_us,
      duration: duration_us,
      data: sample.data
    });
  }

  _getDescription(descriptionBox) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    descriptionBox.write(stream);
    return new Uint8Array(stream.buffer, 8);  // Remove the box header.
  }

  async _tracksReady() {
    let info = await this.source.getInfo();
    this.videoTrack = info.videoTracks[0];
  }

  _selectTrack(track) {
    console.assert(!this.selectedTrack, "changing tracks is not implemented");
    this.selectedTrack = track;
    this.source.selectTrack(track);
  }

  async _readSample() {
    console.assert(this.selectedTrack);
    console.assert(!this._pending_read_resolver);

    if (this.readySamples.length) {
      return Promise.resolve(this.readySamples.shift());
    }

    let promise = new Promise((resolver) => { this._pending_read_resolver = resolver; });
    console.assert(this._pending_read_resolver);
    this.source.start(this._onSamples.bind(this));
    return promise;
  }

  _onSamples(samples) {
    const SAMPLE_BUFFER_TARGET_SIZE = 50;

    this.readySamples.push(...samples);
    if (this.readySamples.length >= SAMPLE_BUFFER_TARGET_SIZE)
      this.source.stop();

    let firstSampleTime = samples[0].cts * 1000000 / samples[0].timescale ;
    debugLog(`adding new ${samples.length} samples (first = ${firstSampleTime}). total = ${this.readySamples.length}`);

    if (this._pending_read_resolver) {
      this._pending_read_resolver(this.readySamples.shift());
      this._pending_read_resolver = null;
    }
  }

  async seek(timeInSeconds) {
    this.readySamples = [];
    if (this._pending_read_resolver) {
      this._pending_read_resolver(null);
      this._pending_read_resolver = null;
    }
    await this.source.seek(timeInSeconds);
  }
}

class MP4Source {
  constructor(uri) {
    this.file = MP4Box.createFile();
    this.file.onError = console.error.bind(console);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    this.file.onSeek = this.onSeek.bind(this);

    debugLog('fetching file');
    fetch(uri).then(response => {
      debugLog('fetch responded');
      const reader = response.body.getReader();
      let offset = 0;
      let mp4File = this.file;

      function appendBuffers({done, value}) {
        if(done) {
          mp4File.flush();
          return;
        }
        let buf = value.buffer;
        buf.fileStart = offset;

        offset += buf.byteLength;

        mp4File.appendBuffer(buf);

        return reader.read().then(appendBuffers);
      }

      return reader.read().then(appendBuffers);
    })

    this.info = null;
    this._info_resolver = null;
    this._seek_resolver = null;
  }

  onReady(info) {
    this.info = info;

    if (this._info_resolver) {
      this._info_resolver(info);
      this._info_resolver = null;
    }
  }

  getInfo() {
    if (this.info)
      return Promise.resolve(this.info);

    return new Promise((resolver) => { this._info_resolver = resolver; });
  }

  getDescriptionBox() {
    // 确保从正确的轨道获取描述
    const entry = this.file.moov.traks.find(trak => trak.tkhd.track_id === this.selectedTrack.id).mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) {
      throw new Error("avcC, hvcC, vpcC, or av1C box not found!");
    }
    return box;
  }

  selectTrack(track) {
      debugLog('selecting track %d', track.id);
      this.selectedTrack = track;
      this.file.setExtractionOptions(track.id);
  }

  start(onSamples) {
    this._onSamples = onSamples;
    this.file.start();
  }

  stop() {
    this.file.stop();
  }

  onSamples(track_id, ref, samples) {
    this._onSamples(samples);
  }

  onSeek() {
    if (this._seek_resolver) {
      this._seek_resolver();
      this._seek_resolver = null;
    }
  }

  async seek(timeInSeconds) {
    // 停止当前的提取
    this.stop();

    // 清除已准备的样本
    this._onSamples = null;

    // 使用 mp4box.js 的 seek 方法
    let seek_time = timeInSeconds;
    let useRap = true; // 寻找最近的关键帧
    this.file.seek(seek_time, useRap);

    // 重新设置提取选项
    this.file.setExtractionOptions(this.selectedTrack.id);

    // 等待 onSeek 回调
    return new Promise((resolve) => {
      this._seek_resolver = resolve;
    });
  }
}
