import { PullDemuxerBase, VIDEO_STREAM_TYPE } from '../lib/pull_demuxer_base.js';

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
    this._selectTrack(this.videoTrack);
  }

  getDecoderConfig() {
    return {
      codec: this.videoTrack.codec.startsWith('vp08') ? 'vp8' : this.videoTrack.codec,
      displayWidth: this.videoTrack.track_width,
      displayHeight: this.videoTrack.track_height,
      description: this._getDescription(this.source.getDescriptionBox())
    };
  }

  async getNextChunk() {
    let sample = await this._readSample();
    return new EncodedVideoChunk({
      type: sample.is_sync ? "key" : "delta",
      timestamp: (sample.cts * 1000000) / sample.timescale,
      duration: (sample.duration * 1000000) / sample.timescale,
      data: sample.data
    });
  }

  async _tracksReady() {
    let info = await this.source.getInfo();
    this.videoTrack = info.videoTracks[0];
  }
}
