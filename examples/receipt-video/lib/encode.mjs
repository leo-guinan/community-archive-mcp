// Pipe raw RGBA frames into ffmpeg and get an H.264 MP4 that plays everywhere.
import { spawn } from "node:child_process";

export function openEncoder(out, { width, height, fps, crf = 18, preset = "veryfast", audio = null }) {
  const args = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-"];
  if (audio) args.push("-i", audio, "-c:a", "aac", "-b:a", "160k", "-shortest");
  args.push("-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
  const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  let failed = null;
  ff.stderr.on("data", (d) => (err += d));
  ff.stdin.on("error", (e) => (failed ??= e));
  const done = new Promise((resolve, reject) => {
    ff.on("error", (e) => reject(new Error(`Couldn't start ffmpeg (${e.message}). Install ffmpeg, or set FFMPEG_PATH to its location.`)));
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-600)}`))));
  });
  return {
    async write(buf) {
      if (failed) throw failed;
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    },
    async close() {
      ff.stdin.end();
      await done;
    },
  };
}

/** Render `scene` (duration in seconds, draw(ctx, t)) to an MP4. */
export async function renderScene(scene, canvas, out, { fps = 30, crf = 18, preset, audio, onProgress } = {}) {
  const ctx = canvas.getContext("2d");
  const frames = Math.round(scene.duration * fps);
  const enc = openEncoder(out, { width: canvas.width, height: canvas.height, fps, crf, preset, audio });
  for (let f = 0; f < frames; f++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    scene.draw(ctx, f / fps);
    await enc.write(canvas.data());
    if (onProgress && f % fps === 0) onProgress(f / frames);
  }
  await enc.close();
  return { frames, seconds: frames / fps };
}
