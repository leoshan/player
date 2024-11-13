const ENABLE_DEBUG_LOGGING = false;

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }
  console.debug(msg);
}

function URLFromFiles(files) {
  const promises = files.map(file =>
    fetch(file).then(response => response.text())
  );

  return Promise.all(promises).then(texts => {
    const text = texts.join("");
    const blob = new Blob([text], { type: "application/javascript" });

    return URL.createObjectURL(blob);
  });
}

// Simple wrapper class for creating AudioWorklet, connecting it to an
// AudioContext, and controlling audio playback.
export class WebAudioController {
  async initialize(sampleRate, channelCount, sharedArrayBuffer) {
    // Set up AudioContext to house graph of AudioNodes and control rendering.
    this.audioContext = new AudioContext({
        sampleRate: sampleRate,
        latencyHint: "playback"
    });
    this.audioContext.suspend();
	this.timeOffset = 0; // Time offset for seeking
    // Make script modules available for execution by AudioWorklet.
    var workletSource = await URLFromFiles(["../third_party/ringbufjs/ringbuf.js", "../lib/audiosink.js"]);
    await this.audioContext.audioWorklet.addModule(workletSource);

    // Get an instance of the AudioSink worklet, passing it the memory for a
    // ringbuffer, connect it to a GainNode for volume. This GainNode is in
    // turn connected to the destination.
    this.audioSink = new AudioWorkletNode(this.audioContext, "AudioSink", {
      processorOptions: {
          sab: sharedArrayBuffer,
          mediaChannelCount: channelCount
      },
      outputChannelCount: [channelCount]
    });
    this.volumeGainNode = new GainNode(this.audioContext);
    this.audioSink.connect(this.volumeGainNode).connect(this.audioContext.destination);
  }

  setVolume(volume) {
    if (volume < 0.0 && volume > 1.0)
      return;

    // Smooth exponential volume ramps on change
    this.volumeGainNode.gain.setTargetAtTime(
      volume,
      this.audioContext.currentTime,
      0.3
    );
  }

  async play() {
    return this.audioContext.resume();
  }

  async pause() {
    return this.audioContext.suspend();
  }

  getMediaTimeInSeconds() {
	  let totalOutputLatency =
		this.audioContext.outputLatency + this.audioContext.baseLatency;
	  return Math.max(this.audioContext.currentTime - totalOutputLatency + this.timeOffset, 0.0);
	}

	seek(timeInSeconds) {
	  if (!this.audioContext) {
		console.warn("AudioContext is not initialized yet.");
		return;
	  }
	  // Adjust the time offset
	  this.timeOffset = timeInSeconds - (this.audioContext.currentTime - this.audioContext.outputLatency);
	}

}
