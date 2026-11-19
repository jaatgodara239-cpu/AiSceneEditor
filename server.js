import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ dest: "/tmp/uploads/" });

app.use(express.json());
app.use(express.static("public"));
app.use("/outputs", express.static("/tmp/outputs"));

fs.mkdirSync("/tmp/uploads", { recursive: true });
fs.mkdirSync("/tmp/outputs", { recursive: true });

const jobs = new Map();
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: "v1beta" }
  });
}

async function runFFmpeg(args) {
  await execFileAsync("ffmpeg", ["-y", ...args]);
}

async function getMediaInfo(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    filePath
  ]);
  const parsed = JSON.parse(stdout || "{}");
  const duration = parseFloat(parsed?.format?.duration || "0");
  const streams = parsed?.streams || [];
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 3.0,
    hasAudio
  };
}

// Generate real, audible SFX files using FFmpeg audio synthesis (no external MP3s required)
async function ensureSynthesizedSfx(sfxDir) {
  fs.mkdirSync(sfxDir, { recursive: true });

  const specs = {
    whoosh: [
      "-f", "lavfi", "-t", "0.45", "-i", "anoisesrc=color=white:amplitude=0.35",
      "-af", "bandpass=f=450:width_type=q:w=1.2,afade=t=in:st=0:d=0.18,afade=t=out:st=0.18:d=0.27,volume=2.4",
      "-ar", "44100", "-ac", "2"
    ],
    impact: [
      "-f", "lavfi", "-t", "0.5", "-i", "sine=frequency=95:beep_factor=0.5",
      "-af", "lowpass=f=160,afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=0.45,volume=2.2",
      "-ar", "44100", "-ac", "2"
    ],
    tick: [
      "-f", "lavfi", "-t", "0.12", "-i", "sine=frequency=1400",
      "-af", "highpass=f=800,afade=t=in:st=0:d=0.005,afade=t=out:st=0.01:d=0.11,volume=1.4",
      "-ar", "44100", "-ac", "2"
    ],
    riser: [
      "-f", "lavfi", "-t", "0.75", "-i", "anoisesrc=color=pink:amplitude=0.25",
      "-af", "highpass=f=250,afade=t=in:st=0:d=0.6,afade=t=out:st=0.62:d=0.13,volume=2.2",
      "-ar", "44100", "-ac", "2"
    ],
    pop: [
      "-f", "lavfi", "-t", "0.18", "-i", "sine=frequency=520",
      "-af", "afade=t=in:st=0:d=0.01,afade=t=out:st=0.02:d=0.16,volume=1.5",
      "-ar", "44100", "-ac", "2"
    ]
  };

  for (const [name, args] of Object.entries(specs)) {
    const outFile = path.join(sfxDir, `${name}.wav`);
    if (!fs.existsSync(outFile)) {
      await runFFmpeg([...args, outFile]);
    }
  }
}

function resolveSfxPath(sfxName, synthSfxDir) {
  if (!sfxName || sfxName === "none") return null;
  const safeName = path.basename(sfxName).replace(/[^a-zA-Z0-9_-]/g, "");

  // Prefer user's custom sfx/ files if present, otherwise use synthesized WAVs
  for (const ext of [".mp3", ".wav", ".ogg"]) {
    const custom = path.join(process.cwd(), "sfx", `${safeName}${ext}`);
    if (fs.existsSync(custom)) return custom;
  }

  const synth = path.join(synthSfxDir, `${safeName}.wav`);
  return fs.existsSync(synth) ? synth : null;
}

function wrapBannerText(text, maxCharsPerLine = 24, maxLines = 2) {
  const words = String(text || "")
    .replace(/['":\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const lines = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length <= maxCharsPerLine) {
      current = (current + " " + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.join("\n");
}

function extractAudioBase64(interaction) {
  if (!interaction) return null;
  if (interaction.output_audio?.data) return interaction.output_audio.data;
  if (Array.isArray(interaction.steps)) {
    for (let i = interaction.steps.length - 1; i >= 0; i--) {
      const items = interaction.steps[i]?.content || interaction.steps[i]?.outputs || [];
      for (const item of items) {
        if (item?.type === "audio" && item?.data) return item.data;
      }
    }
  }
  if (Array.isArray(interaction.outputs)) {
    const found = interaction.outputs.find((o) => o?.type === "audio" && o?.data);
    if (found) return found.data;
  }
  return null;
}

app.post("/api/invent-template", async (req, res) => {
  try {
    const ai = getAI();
    const { niche, clipCount } = req.body || {};
    const prompt = `
You are a viral YouTube Shorts editor who designs high-retention edits from raw clips.
Create a dynamic Shorts editing template for:
Niche/Vibe: ${niche || "Funny / shocking / unexpected moments"}
Number of raw clips uploaded: ${clipCount || 2}

Choose ONE layout:
- "banner_top_white": High-contrast white top header card with bold black hook text, framed clip in center, clean bottom tag.
- "banner_dark_cinema": Dark top/bottom framing with bold white/yellow hook text and motion.
- "split_zoom_focus": Top half shows full clip, bottom half shows zoomed-in action focus + hook badge.
- "full_punch_cuts": Full-screen 9:16 dynamic crop with bold hook text and rapid motion cuts.

Available SFX cues: "whoosh", "impact", "tick", "riser", "pop".

Return ONLY valid JSON:
{
  "templateName": "Short catchy name",
  "layout": "banner_top_white",
  "topHookText": "Punchy 4-7 word hook",
  "bottomTagText": "Short 2-4 word tag",
  "cutDurationSec": 2.0,
  "contrastBoost": 1.08,
  "saturationBoost": 1.15,
  "voiceHookLine": "Punchy 1-sentence opening hook",
  "beatSfx": ["whoosh", "impact", "pop", "riser"]
}
`;

    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" }
    });

    const template = JSON.parse(result.text);
    res.json({ template });
  } catch (err) {
    console.error("Template generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function renderShortJob(jobId, clipFiles, template, options) {
  const workDir = `/tmp/job_${jobId}`;
  const synthSfxDir = path.join(workDir, "synth_sfx");
  fs.mkdirSync(workDir, { recursive: true });

  const update = (progress, status, extra = {}) => {
    jobs.set(jobId, { id: jobId, progress, status, ...extra });
  };

  try {
    update(8, "Synthesizing sound effects & preparing edit...");
    await ensureSynthesizedSfx(synthSfxDir);

    const outW = 720;
    const outH = 1280;
    const allowedLayouts = new Set([
      "banner_top_white",
      "banner_dark_cinema",
      "split_zoom_focus",
      "full_punch_cuts"
    ]);
    const layout = allowedLayouts.has(template.layout) ? template.layout : "banner_top_white";
    const cutSec = Math.min(4.5, Math.max(1.2, Number(template.cutDurationSec) || 2.0));
    const contrast = Math.min(1.25, Math.max(0.95, Number(template.contrastBoost) || 1.08));
    const saturation = Math.min(1.35, Math.max(0.9, Number(template.saturationBoost) || 1.15));
    const topHook = wrapBannerText(template.topHookText || "WAIT FOR THE END", 24, 2);
    const bottomTag = wrapBannerText(template.bottomTagText || "", 28, 1);
    const beatSfxList =
      Array.isArray(template.beatSfx) && template.beatSfx.length
        ? template.beatSfx
        : ["whoosh", "impact", "pop", "riser"];

    let voiceHookPath = null;
    if (options.useVoiceHook && template.voiceHookLine && template.voiceHookLine.trim()) {
      try {
        update(14, "Generating AI voice hook...");
        const ai = getAI();
        const tts = await ai.interactions.create({
          model: "gemini-3.8-flash-tts",
          input: [
            {
              type: "user_input",
              content: [
                {
                  type: "text",
                  text: template.voiceHookLine.trim(),
                  annotations: [{ type: "speech_metadata", style: "energetic, punchy YouTube Shorts narrator" }]
                }
              ]
            }
          ],
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice: options.voice || "Puck" }] }
        });
        const audioB64 = extractAudioBase64(tts);
        if (audioB64) {
          voiceHookPath = path.join(workDir, "voice_hook.wav");
          fs.writeFileSync(voiceHookPath, Buffer.from(audioB64, "base64"));
        }
      } catch (e) {
        console.warn("Voice hook skipped:", e.message);
      }
    }

    update(20, "Slicing raw clips into high-retention beats...");
    const rawSlices = [];
    let totalTargetSec = 0;
    const maxShortSec = 26;

    for (let c = 0; c < clipFiles.length; c++) {
      if (totalTargetSec >= maxShortSec) break;
      const clip = clipFiles[c];
      const info = await getMediaInfo(clip.path);
      let cursor = 0;

      while (cursor + 0.8 < info.duration && totalTargetSec < maxShortSec) {
        const segDur = Math.min(cutSec, info.duration - cursor, maxShortSec - totalTargetSec);
        rawSlices.push({
          srcPath: clip.path,
          start: cursor,
          duration: segDur,
          hasAudio: info.hasAudio
        });
        cursor += segDur;
        totalTargetSec += segDur;
      }
    }

    if (!rawSlices.length) {
      throw new Error("Could not extract playable segments from uploaded clips.");
    }

    const renderedSegments = [];

    for (let i = 0; i < rawSlices.length; i++) {
      const slice = rawSlices[i];
      const sfxKey = beatSfxList[i % beatSfxList.length];
      const pct = 25 + Math.floor((i / rawSlices.length) * 62);
      update(pct, `Editing beat ${i + 1}/${rawSlices.length} + SFX (${sfxKey})...`);

      const segOut = path.join(workDir, `beat_${i}.mp4`);
      const zoomDir = i % 2 === 0 ? 1 : -1;
      const padScale = 1.14;
      const colorGrade = `eq=contrast=${contrast}:saturation=${saturation}`;

      // Subtle retention progress bar at the very top (0px -> 720px across the Short)
      const startFrac = (i / rawSlices.length).toFixed(4);
      const endFrac = ((i + 1) / rawSlices.length).toFixed(4);
      const barExpr = `${outW}*(${startFrac}+(${endFrac}-${startFrac})*(t/${slice.duration.toFixed(3)}))`;
      const progressBar = `,drawbox=x=0:y=0:w='${barExpr}':h=10:color=#ef4444:t=fill`;

      const drawTopText = topHook
        ? `,drawtext=fontfile=${FONT_PATH}:text='${topHook}':fontcolor=${
            layout === "banner_top_white" ? "black" : "white"
          }:fontsize=40:line_spacing=8:x=(w-text_w)/2:y=${
            layout === "banner_top_white" ? "95" : "105"
          }`
        : "";
      const drawBottomText = bottomTag
        ? `,drawtext=fontfile=${FONT_PATH}:text='${bottomTag}':fontcolor=${
            layout === "banner_top_white" ? "black" : "#facc15"
          }:fontsize=32:x=(w-text_w)/2:y=h-120`
        : "";

      let vf = "";
      if (layout === "banner_top_white") {
        const boxH = 820;
        const scaledW = Math.round(outW * padScale);
        const scaledH = Math.round(boxH * padScale);
        const dx = scaledW - outW;
        const dy = scaledH - boxH;
        const cropMotion =
          zoomDir === 1
            ? `crop=${outW}:${boxH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
            : `crop=${outW}:${boxH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

        vf =
          `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade}[vid];` +
          `color=c=white:s=${outW}x${outH}:d=${slice.duration}[bg];` +
          `[bg][vid]overlay=0:230${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
      } else if (layout === "banner_dark_cinema") {
        const boxH = 840;
        const scaledW = Math.round(outW * padScale);
        const scaledH = Math.round(boxH * padScale);
        const dx = scaledW - outW;
        const dy = scaledH - boxH;
        const cropMotion =
          zoomDir === 1
            ? `crop=${outW}:${boxH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
            : `crop=${outW}:${boxH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

        vf =
          `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade}[vid];` +
          `color=c=0x0b0d12:s=${outW}x${outH}:d=${slice.duration}[bg];` +
          `[bg][vid]overlay=0:220${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
      } else if (layout === "split_zoom_focus") {
        const halfH = outH / 2;
        vf =
          `[0:v]split=2[v1][v2];` +
          `[v1]scale=${outW}:${halfH}:force_original_aspect_ratio=increase,crop=${outW}:${halfH},${colorGrade}[top];` +
          `[v2]scale=${Math.round(outW * 1.45)}:${Math.round(halfH * 1.45)}:force_original_aspect_ratio=increase,crop=${outW}:${halfH},${colorGrade}[bot];` +
          `[top][bot]vstack=inputs=2,drawbox=x=24:y=65:w=${outW - 48}:h=130:color=black@0.75:t=fill${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
      } else {
        const scaledW = Math.round(outW * 1.15);
        const scaledH = Math.round(outH * 1.15);
        const dx = scaledW - outW;
        const dy = scaledH - outH;
        const cropMotion =
          zoomDir === 1
            ? `crop=${outW}:${outH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
            : `crop=${outW}:${outH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

        vf =
          `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade},` +
          `drawbox=x=24:y=65:w=${outW - 48}:h=135:color=black@0.72:t=fill${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
      }

      const ffInputs = ["-ss", slice.start.toFixed(2), "-t", slice.duration.toFixed(2), "-i", slice.srcPath];
      const audioFilters = [];
      const mixLabels = [];

      if (slice.hasAudio) {
        audioFilters.push(`[0:a]aresample=44100,volume=0.8[basea]`);
        mixLabels.push("[basea]");
      } else {
        ffInputs.push("-f", "lavfi", "-t", slice.duration.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");
        audioFilters.push(`[1:a]volume=0.0[basea]`);
        mixLabels.push("[basea]");
      }

      const sfxPath = resolveSfxPath(sfxKey, synthSfxDir);
      if (sfxPath) {
        const sfxIdx = ffInputs.filter((x) => x === "-i").length;
        ffInputs.push("-i", sfxPath);
        audioFilters.push(`[${sfxIdx}:a]aresample=44100,volume=0.95[sfxa]`);
        mixLabels.push("[sfxa]");
      }

      if (i === 0 && voiceHookPath) {
        const vIdx = ffInputs.filter((x) => x === "-i").length;
        ffInputs.push("-i", voiceHookPath);
        audioFilters.push(`[${vIdx}:a]aresample=44100,volume=1.2[vhook]`);
        mixLabels.push("[vhook]");
      }

      audioFilters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=1[outa]`);

      await runFFmpeg([
        ...ffInputs,
        "-filter_complex", `${vf};${audioFilters.join(";")}`,
        "-map", "[outv]",
        "-map", "[outa]",
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        segOut
      ]);

      renderedSegments.push(segOut);
    }

    update(90, "Exporting final Short MP4...");
    const concatPath = path.join(workDir, "concat.txt");
    fs.writeFileSync(concatPath, renderedSegments.map((p) => `file '${p}'`).join("\n"));

    const outFilename = `short_${jobId}.mp4`;
    const finalPath = path.join("/tmp/outputs", outFilename);

    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-c", "copy",
      "-movflags", "+faststart",
      finalPath
    ]);

    update(100, "Done!", {
      done: true,
      downloadUrl: `/outputs/${outFilename}`
    });
  } catch (err) {
    console.error("Render failed:", err);
    update(0, `Error: ${err.message}`, { error: true });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const f of clipFiles) fs.rmSync(f.path, { force: true });
  }
}

app.post("/api/render-short", upload.array("clips", 8), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: "Upload at least 1 video clip." });
  }

  let template = {};
  try {
    template = JSON.parse(req.body.templateJson || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid template JSON." });
  }

  const jobId = Date.now().toString(36);
  jobs.set(jobId, { id: jobId, progress: 3, status: "Queued..." });

  renderShortJob(jobId, req.files, template, {
    useVoiceHook: req.body.useVoiceHook === "true",
    voice: req.body.voice || "Puck"
  });

  res.json({ jobId });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shorts Template Studio running on ${PORT}`));
                                  
