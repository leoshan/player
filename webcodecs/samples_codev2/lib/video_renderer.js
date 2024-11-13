export class VideoRenderer {
  async initialize(demuxer, canvas) {
  try {
    console.log("Initializing VideoRenderer");
    this.demuxer = demuxer;
    await this.demuxer.initialize(VIDEO_STREAM_TYPE);
    console.log("Demuxer initialized");

    const config = this.demuxer.getDecoderConfig();
    console.log("Decoder config:", config);
    this.canvas = canvas;
    this.canvas.width = config.codedWidth;
    this.canvas.height = config.codedHeight;
    this.canvasCtx = canvas.getContext('2d');

    this.decoder = new VideoDecoder({
      output: this.bufferFrame.bind(this),
      error: (e) => console.error(e),
    });

    console.assert(await VideoDecoder.isConfigSupported(config));
    console.log("Config supported. Configuring decoder...");

    // 配置解码器
    this.decoder.configure(config);

  } catch (e) {
    console.error('Error in VideoRenderer.initialize:', e);
    throw e;
  }
}


  // Render video based on the provided currentTime from audio
  render(currentTime) {
    let frame = this.chooseFrame(currentTime * 1000000); // Convert to microseconds
    this.fillFrameBuffer();

    if (frame == null) {
      console.warn('VideoRenderer.render(): no frame ');
      return;
    }

    this.paint(frame);
  }

  chooseFrame(timestamp) {
    if (this.frameBuffer.length == 0)
      return null;

    let minTimeDelta = Number.MAX_VALUE;
    let frameIndex = -1;

    for (let i = 0; i < this.frameBuffer.length; i++) {
      let time_delta = Math.abs(timestamp - this.frameBuffer[i].timestamp);
      if (time_delta < minTimeDelta) {
        minTimeDelta = time_delta;
        frameIndex = i;
      } else {
        break;
      }
    }

    console.assert(frameIndex != -1);

    if (frameIndex > 0)
      console.log('dropping %d stale frames', frameIndex);

    for (let i = 0; i < frameIndex; i++) {
      let staleFrame = this.frameBuffer.shift();
      staleFrame.close();
    }

    let chosenFrame = this.frameBuffer[0];
    console.log('frame time delta = %dms (%d vs %d)', minTimeDelta/1000, timestamp, chosenFrame.timestamp)
    return chosenFrame;
  }

  async fillFrameBuffer() {
    if (this.frameBufferFull()) {
      if (this.init_resolver) {
        this.init_resolver();
        this.init_resolver = null;
      }

      return;
    }

    if (this.fillInProgress) {
      return false;
    }
    this.fillInProgress = true;

    while (this.frameBuffer.length < 3 &&
            this.decoder.decodeQueueSize < 3) {
      let chunk = await this.demuxer.getNextChunk();
      if (!chunk) {
        break; // No more chunks available
      }
      this.decoder.decode(chunk);
    }

    this.fillInProgress = false;

    setTimeout(this.fillFrameBuffer.bind(this), 0);
  }

  frameBufferFull() {
    return this.frameBuffer.length >= 3;
  }

  bufferFrame(frame) {
    this.frameBuffer.push(frame);
  }

  paint(frame) {
    this.canvasCtx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close(); // Close the frame after painting
  }
}
