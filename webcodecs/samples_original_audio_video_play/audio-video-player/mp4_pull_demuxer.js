import {PullDemuxerBase, AUDIO_STREAM_TYPE, VIDEO_STREAM_TYPE} from '../lib/pull_demuxer_base.js'

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

  async initialize(streamType) {
    this.source = new MP4Source(this.fileUri);
    this.readySamples = [];
    this._pending_read_resolver = null;
    this.streamType = streamType;

    await this._tracksReady();

    if (this.streamType == AUDIO_STREAM_TYPE) {
      this._selectTrack(this.audioTrack);
    } else {
      this._selectTrack(this.videoTrack);
    }
  }

  getDecoderConfig() {
    if (this.streamType == AUDIO_STREAM_TYPE) {
      return {
        codec: this.audioTrack.codec,
        sampleRate: this.audioTrack.audio.sample_rate,
        numberOfChannels: this.audioTrack.audio.channel_count,
        description: this.source.getAudioSpecificConfig()
      };
    } else {
      return {
        // Browser doesn't support parsing full vp8 codec (eg: `vp08.00.41.08`),
        // they only support `vp8`.
        codec: this.videoTrack.codec.startsWith('vp08') ? 'vp8' : this.videoTrack.codec,
        displayWidth: this.videoTrack.track_width,
        displayHeight: this.videoTrack.track_height,
        description: this._getDescription(this.source.getDescriptionBox())
      }
    }
  }

  async getNextChunk() {
    let sample = await this._readSample();
    const type = sample.is_sync ? "key" : "delta";
    const pts_us = (sample.cts * 1000000) / sample.timescale;
    const duration_us = (sample.duration * 1000000) / sample.timescale;
    const ChunkType = this.streamType == AUDIO_STREAM_TYPE ? EncodedAudioChunk : EncodedVideoChunk;
    return new ChunkType({
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
    this.audioTrack = info.audioTracks[0];
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
}

class MP4Source {
  constructor(uri) {
    this.file = MP4Box.createFile();
    this.file.onError = console.error.bind(console);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);

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
  }
  
  onReady(info) {
    // TODO: Generate configuration changes.
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
    // TODO: make sure this is coming from the right track.
    const entry = this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) {
      throw new Error("avcC, hvcC, vpcC, or av1C box not found!");
    }
    return box;
  }

getAudioSpecificConfig() {
    // 根据所选轨道的 ID，找到对应的轨道
    const trak = this.file.moov.traks.find(trak => trak.tkhd.track_id === this.selectedTrack.id);
    if (!trak) {
        throw new Error("Selected track not found in moov.traks.");
    }

    // 获取样本描述条目
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    if (!entry) {
        throw new Error("No sample description entries found in the selected track.");
    }

    // 递归查找 'esds' 盒子
    let esdsBox = null;
    function findEsdsBox(box) {
        if (box.type === 'esds') {
            esdsBox = box;
        } else if (box.boxes) {
            for (let childBox of box.boxes) {
                findEsdsBox(childBox);
                if (esdsBox) break;
            }
        }
    }
    findEsdsBox(entry);

    if (!esdsBox) {
        throw new Error("esds box not found in audio track sample entry.");
    }

    // 检查 'esds' 盒子的内容，并返回 AudioSpecificConfig
    console.assert(esdsBox.esd.descs[0].tag == 0x04);
    console.assert(esdsBox.esd.descs[0].oti == 0x40);
    console.assert(esdsBox.esd.descs[0].descs[0].tag == 0x05);

    return esdsBox.esd.descs[0].descs[0].data;
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
}
