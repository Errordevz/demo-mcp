/*
 * Functions sent into Chromium by the video pipeline. Keep each exported
 * function self-contained: Puppeteer serialises Function.prototype.toString().
 */

export interface InstallVideoResult {
  found: boolean;
  ready: boolean;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudioTrack: boolean | null;
  error: string | null;
}

export interface CapturedAudioResult {
  status: "ok" | "no_audio_track" | "unsupported" | "timeout" | "error";
  mimeType: string | null;
  base64: string | null;
  bytes: number;
  durationSeconds: number | null;
  message: string | null;
}

/** Add a normal HTML5 video element for a direct public media URL when the
 * browser did not create one while navigating to the URL. */
export async function installPublicVideo(options: { src: string; timeoutMs: number }): Promise<InstallVideoResult> {
  const existing = document.querySelector("video") as HTMLVideoElement | null;
  const video = existing ?? document.createElement("video");
  if (!existing) {
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", "Public video under inspection");
    document.body?.appendChild(video);
  }
  if (!video.src || video.src !== options.src) {
    video.src = options.src;
    video.load();
  }
  const read = (): InstallVideoResult => ({
    found: true,
    ready: video.readyState >= 1,
    durationSeconds: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
    width: video.videoWidth || null,
    height: video.videoHeight || null,
    hasAudioTrack: null,
    error: video.error ? video.error.message || `media error ${video.error.code}` : null,
  });
  if (video.readyState >= 1) return read();
  return await new Promise<InstallVideoResult>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("canplay", finish);
      resolve(read());
    };
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("canplay", finish, { once: true });
    setTimeout(finish, Math.max(500, Math.min(options.timeoutMs || 8_000, 15_000)));
  });
}

/**
 * Best-effort audio extraction using the browser's public Media Capture API.
 * It only records decoded, non-DRM media that the page can play; it does not
 * read cookies, intercept requests or bypass a media access control.
 */
export async function capturePublicAudio(options: { index: number; maxSeconds: number; maxBytes: number }): Promise<CapturedAudioResult> {
  const videos = document.querySelectorAll("video");
  const video = videos[options.index] as HTMLVideoElement | undefined;
  if (!video) return { status: "error", mimeType: null, base64: null, bytes: 0, durationSeconds: null, message: "No HTML5 video element was available." };
  const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }).captureStream ?? (video as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
  if (typeof capture !== "function" || typeof MediaRecorder === "undefined") {
    return { status: "unsupported", mimeType: null, base64: null, bytes: 0, durationSeconds: Number.isFinite(video.duration) ? video.duration : null, message: "This browser does not expose captureStream or MediaRecorder for the public video." };
  }
  let stream: MediaStream;
  try {
    stream = capture.call(video);
  } catch (error) {
    return { status: "error", mimeType: null, base64: null, bytes: 0, durationSeconds: null, message: String(error).slice(0, 300) };
  }
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    return { status: "no_audio_track", mimeType: null, base64: null, bytes: 0, durationSeconds: Number.isFinite(video.duration) ? video.duration : null, message: "The decoded video stream has no audio track." };
  }
  const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
  if (!mimeType) return { status: "unsupported", mimeType: null, base64: null, bytes: 0, durationSeconds: null, message: "MediaRecorder has no supported audio output format." };

  return await new Promise<CapturedAudioResult>((resolve) => {
    const chunks: Blob[] = [];
    let stopped = false;
    let timer: any;
    let recorder: MediaRecorder;
    const finish = async (status: CapturedAudioResult["status"], message: string | null = null): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const track of audioTracks) track.stop();
      if (status !== "ok") {
        resolve({ status, mimeType, base64: null, bytes: 0, durationSeconds: Number.isFinite(video.duration) ? video.duration : null, message });
        return;
      }
      try {
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size > options.maxBytes) {
          resolve({ status: "error", mimeType, base64: null, bytes: blob.size, durationSeconds: Number.isFinite(video.duration) ? video.duration : null, message: `Captured audio exceeded ${options.maxBytes} bytes.` });
          return;
        }
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        resolve({ status: "ok", mimeType, base64: btoa(binary), bytes: blob.size, durationSeconds: Number.isFinite(video.duration) ? video.duration : null, message: null });
      } catch (error) {
        resolve({ status: "error", mimeType, base64: null, bytes: 0, durationSeconds: null, message: String(error).slice(0, 300) });
      }
    };
    try {
      recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType });
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = () => void finish("error", "MediaRecorder reported an error.");
      recorder.onstop = () => void finish("ok");
      recorder.start(250);
      const play = video.play();
      if (play && typeof play.catch === "function") void play.catch(() => undefined);
      timer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
        else void finish("timeout", "Audio capture stopped before the recorder produced data.");
      }, Math.max(1_000, Math.min(options.maxSeconds * 1000, 120_000)));
    } catch (error) {
      void finish("error", String(error).slice(0, 300));
    }
  });
}
