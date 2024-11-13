// Constants passed to initialize() to indicate which stream should be demuxed.
export const VIDEO_STREAM_TYPE = 1;

export class PullDemuxerBase {
  async initialize(streamType) {}
  getDecoderConfig() {}
  async getNextChunk() {}
}
