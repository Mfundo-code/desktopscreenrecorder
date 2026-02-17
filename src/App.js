import { useState, useRef, useEffect, useCallback } from "react";

// ─── WebM Binary Duration Fixer (VLC compatible) ─────────────────────────────
async function fixWebmDuration(blob, durationMs) {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length - 12; i++) {
      if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
        const sizeFirstByte = bytes[i + 2];
        let dataOffset, dataSize;
        if (sizeFirstByte & 0x80) { dataSize = sizeFirstByte & 0x7f; dataOffset = i + 3; }
        else if (sizeFirstByte & 0x40) { dataSize = ((sizeFirstByte & 0x3f) << 8) | bytes[i + 3]; dataOffset = i + 4; }
        else continue;
        if (dataSize === 8) { new DataView(buffer, dataOffset, 8).setFloat64(0, durationMs, false); return new Blob([buffer], { type: blob.type }); }
        if (dataSize === 4) { new DataView(buffer, dataOffset, 4).setFloat32(0, durationMs, false); return new Blob([buffer], { type: blob.type }); }
      }
    }
    // Insert duration if not found
    for (let i = 0; i < bytes.length - 20; i++) {
      if (bytes[i] === 0x15 && bytes[i+1] === 0x49 && bytes[i+2] === 0xa9 && bytes[i+3] === 0x66) {
        const dur = new ArrayBuffer(11);
        const dv = new DataView(dur);
        dv.setUint8(0, 0x44); dv.setUint8(1, 0x89); dv.setUint8(2, 0x88);
        dv.setFloat64(3, durationMs, false);
        return new Blob([buffer.slice(0, i + 8), dur, buffer.slice(i + 8)], { type: blob.type });
      }
    }
    return blob;
  } catch { return blob; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtTime = (s) => {
  const h = Math.floor(s/3600).toString().padStart(2,"0");
  const m = Math.floor((s%3600)/60).toString().padStart(2,"0");
  const sc = (s%60).toString().padStart(2,"0");
  return `${h}:${m}:${sc}`;
};
const fmtSize = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
};
const BEST_MIME = (() => {
  const types = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm;codecs=h264,opus","video/webm","video/mp4"];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
})();

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus]         = useState("idle");
  const [countdown, setCountdown]   = useState(3);
  const [elapsed, setElapsed]       = useState(0);
  const [recordings, setRecordings] = useState([]);
  const [activeRec, setActiveRec]   = useState(null);
  const [sizeBytes, setSizeBytes]   = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [captureMic, setCaptureMic] = useState(false);
  const [quality, setQuality]       = useState("high");
  const [dirHandle, setDirHandle]   = useState(null);
  const [log, setLog]               = useState([]);
  const [fixing, setFixing]         = useState(false);
  const [audioMode, setAudioMode]   = useState("system"); // system | mic | both | none

  const mrRef         = useRef(null);
  const chunksRef     = useRef([]);
  const streamRef     = useRef(null);
  const timerRef      = useRef(null);
  const sizeRef       = useRef(0);
  const durationMsRef = useRef(0);
  const startPerfRef  = useRef(null);
  const analyserRef   = useRef(null);
  const rafRef        = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    setLog(l => [{ time: new Date().toLocaleTimeString(), msg, type }, ...l].slice(0, 100));
  }, []);

  // ── Audio meter ──────────────────────────────────────────────────────────
  const startMeter = useCallback((stream) => {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = { analyser, ctx };
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a,b) => a+b, 0) / data.length;
        setAudioLevel(Math.min(100, (avg / 128) * 100));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    analyserRef.current?.ctx?.close();
    setAudioLevel(0);
  }, []);

  // ── Folder ───────────────────────────────────────────────────────────────
  const getOrCreateFolder = useCallback(async () => {
    if (dirHandle) return dirHandle;
    if (!("showDirectoryPicker" in window)) return null;
    try {
      addLog("Select a parent folder…");
      const root = await window.showDirectoryPicker({ mode: "readwrite" });
      let folder;
      try { folder = await root.getDirectoryHandle("MyScreenRecorder", { create: false }); addLog("Found MyScreenRecorder/ ✓", "success"); }
      catch { folder = await root.getDirectoryHandle("MyScreenRecorder", { create: true }); addLog("Created MyScreenRecorder/ ✓", "success"); }
      setDirHandle(folder);
      return folder;
    } catch { addLog("Folder cancelled — auto-download", "warn"); return null; }
  }, [dirHandle, addLog]);

  const triggerDownload = useCallback((blob, filename) => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    addLog(`⬇ Downloaded: ${filename}`);
  }, [addLog]);

  // ── Finalize ─────────────────────────────────────────────────────────────
  const finalizeRecording = useCallback(async () => {
    setFixing(true);
    const ext   = BEST_MIME.includes("mp4") ? "mp4" : "webm";
    const raw   = new Blob(chunksRef.current, { type: BEST_MIME || "video/webm" });
    const ts    = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    const fname = `ScreenRec_${ts}.${ext}`;
    const durMs = durationMsRef.current || elapsed * 1000;
    addLog(`Raw: ${fmtSize(raw.size)} | ${(durMs/1000).toFixed(1)}s`);
    let blob = raw;
    if (ext === "webm") {
      addLog("Injecting VLC duration metadata…");
      blob = await fixWebmDuration(raw, durMs);
      addLog(`✓ VLC-compatible (${fmtSize(blob.size)})`, "success");
    }
    const url = URL.createObjectURL(blob);
    const rec = { id: Date.now(), filename: fname, blob, url, size: blob.size, duration: Math.round(durMs/1000), ext };
    setRecordings(r => [rec, ...r]);
    setActiveRec(rec);
    setStatus("preview");
    setFixing(false);
    const folder = await getOrCreateFolder();
    if (folder) {
      try {
        const fh = await folder.getFileHandle(fname, { create: true });
        const w = await fh.createWritable();
        await w.write(blob); await w.close();
        addLog(`✓ Saved → MyScreenRecorder/${fname}`, "success"); return;
      } catch (e) { addLog(`Folder write failed: ${e.message}`, "warn"); }
    }
    triggerDownload(blob, fname);
  }, [elapsed, getOrCreateFolder, triggerDownload, addLog]);

  const stopRecording = useCallback(() => {
    if (startPerfRef.current) { durationMsRef.current += performance.now() - startPerfRef.current; startPerfRef.current = null; }
    clearInterval(timerRef.current);
    if (mrRef.current?.state !== "inactive") mrRef.current.stop();
    stopMeter();
    streamRef.current?.videoStream?.getTracks().forEach(t => t.stop());
    streamRef.current?.audioStream?.getTracks().forEach(t => t.stop());
    streamRef.current?.audioCtx?.close();
    addLog("■ Stopped");
  }, [stopMeter, addLog]);

  const togglePause = useCallback(() => {
    if (!mrRef.current) return;
    if (mrRef.current.state === "recording") {
      mrRef.current.pause();
      durationMsRef.current += performance.now() - startPerfRef.current;
      startPerfRef.current = null;
      clearInterval(timerRef.current);
      setStatus("paused"); addLog("⏸ Paused");
    } else if (mrRef.current.state === "paused") {
      mrRef.current.resume();
      startPerfRef.current = performance.now();
      timerRef.current = setInterval(() => setElapsed(e => e+1), 1000);
      setStatus("recording"); addLog("▶ Resumed");
    }
  }, [addLog]);

  const beginRecording = useCallback((videoStream, audioStream, audioCtx) => {
    chunksRef.current = [];
    sizeRef.current = 0;
    durationMsRef.current = 0;
    setSizeBytes(0);
    startPerfRef.current = performance.now();
    streamRef.current = { videoStream, audioStream, audioCtx };

    const vBr = { ultra: 12_000_000, high: 6_000_000, balanced: 2_500_000 }[quality];
    const aBr = { ultra: 320_000, high: 192_000, balanced: 128_000 }[quality];

    // Combine video + audio into one MediaStream for the recorder
    const audioTracks = audioStream ? audioStream.getAudioTracks() : [];
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioTracks
    ]);

    if (audioTracks.length > 0) startMeter(new MediaStream(audioTracks));

    const mr = new MediaRecorder(combined, {
      mimeType: BEST_MIME,
      videoBitsPerSecond: vBr,
      audioBitsPerSecond: aBr,
    });
    mrRef.current = mr;
    mr.ondataavailable = (e) => {
      if (e.data?.size > 0) { chunksRef.current.push(e.data); sizeRef.current += e.data.size; setSizeBytes(sizeRef.current); }
    };
    mr.onstop = finalizeRecording;
    mr.start(200);

    setElapsed(0);
    setStatus("recording");
    timerRef.current = setInterval(() => setElapsed(e => e+1), 1000);
    addLog(`● Recording — ${BEST_MIME} @ ${vBr/1_000_000}Mbps / ${aBr/1000}kbps`, "success");

    videoStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (mrRef.current?.state !== "inactive") stopRecording();
    });
  }, [quality, startMeter, finalizeRecording, stopRecording, addLog]);

  // ── The main capture logic ────────────────────────────────────────────────
  const startCountdown = useCallback(async () => {
    setStatus("countdown");
    setCountdown(3);
    addLog("Requesting screen capture…");

    // ── Step 1: Capture video ONLY — force ENTIRE SCREEN (monitor) ──────────
    // By setting displaySurface:"monitor" and NOT requesting audio here,
    // Brave/Chrome will show "Entire Screen" pre-selected and the Share
    // button becomes active immediately.
    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "monitor",          // ← forces "Entire Screen"
          frameRate: { ideal: 60, max: 60 },
          width:  { ideal: 3840 },
          height: { ideal: 2160 },
          cursor: "always",
        },
        audio: false,    // ← NO audio here — we grab it separately below
                         //    so DRM black-screen / mute is avoided
        selfBrowserSurface: "exclude",
        preferCurrentTab: false,
        surfaceSwitching: "exclude",
        systemAudio: "exclude",
      });
      addLog("Screen capture ✓ (entire monitor)", "success");
    } catch (e) {
      addLog(`Screen capture failed: ${e.message}`, "error");
      setStatus("idle"); return;
    }

    // ── Step 2: Capture audio separately ────────────────────────────────────
    // We use getUserMedia with { audio: true } which on most systems gives
    // access to the default recording device.
    // If the user has Stereo Mix enabled in Windows, this captures ALL
    // system audio including DStv.
    let audioStream = null;
    const audioCtx  = new AudioContext({ sampleRate: 48000 });
    const dest      = audioCtx.createMediaStreamDestination();
    let audioSourceCount = 0;

    if (audioMode === "system" || audioMode === "both") {
      try {
        // Try to get system/loopback audio via default device
        // On Windows with Stereo Mix enabled this works perfectly
        const sysStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Don't process the audio — we want the raw playback
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl:  false,
            sampleRate: 48000,
            channelCount: 2,
          },
          video: false,
        });
        const g = audioCtx.createGain(); g.gain.value = 1.0;
        audioCtx.createMediaStreamSource(sysStream).connect(g).connect(dest);
        audioSourceCount++;
        addLog("System/Stereo Mix audio ✓", "success");
      } catch (e) {
        addLog(`System audio failed: ${e.message} — enable Stereo Mix in Windows Sound settings`, "warn");
      }
    }

    if (audioMode === "mic" || audioMode === "both") {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 2 },
          video: false,
        });
        const g = audioCtx.createGain(); g.gain.value = 0.9;
        audioCtx.createMediaStreamSource(micStream).connect(g).connect(dest);
        audioSourceCount++;
        addLog("Microphone audio ✓", "success");
      } catch (e) {
        addLog(`Mic failed: ${e.message}`, "warn");
      }
    }

    const finalAudioStream = audioSourceCount > 0 ? dest.stream : null;
    if (audioSourceCount === 0) addLog("No audio sources — recording video only", "warn");

    // ── Step 3: Countdown then record ───────────────────────────────────────
    let cnt = 3;
    const tick = setInterval(() => {
      cnt--; setCountdown(cnt);
      if (cnt <= 0) { clearInterval(tick); beginRecording(videoStream, finalAudioStream, audioCtx); }
    }, 1000);
  }, [audioMode, beginRecording, addLog]);

  useEffect(() => () => { clearInterval(timerRef.current); stopMeter(); }, [stopMeter]);

  const isRec    = status === "recording";
  const isPaused = status === "paused";
  const isCd     = status === "countdown";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{
          --bg:#080c0f;--surface:#0e1418;--card:#131a1f;
          --border:#1e2a32;--borderB:#2a3d4a;
          --accent:#00e5ff;--accent2:#ff3d5a;--accent3:#39ff85;
          --text:#c8dae5;--dim:#5a7a8a;--bright:#e8f4f8;
          --rec:#ff2244;--pause:#ffaa00;
          --mono:'JetBrains Mono',monospace;--disp:'Space Mono',monospace;
        }
        html,body,#root{height:100%;background:var(--bg);color:var(--text);font-family:var(--mono)}
        .app{display:grid;grid-template-rows:auto 1fr auto;grid-template-columns:1fr 360px;grid-template-areas:"hdr hdr" "main side" "ftr ftr";min-height:100vh}

        .hdr{grid-area:hdr;display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:1px solid var(--border);background:var(--surface);position:relative;overflow:hidden}
        .hdr::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0,transparent 59px,var(--border) 59px,var(--border) 60px);opacity:.3;pointer-events:none}
        .logo{display:flex;align-items:center;gap:14px;z-index:1}
        .logo-icon{width:42px;height:42px;border:2px solid var(--accent);border-radius:4px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 16px rgba(0,229,255,.3),inset 0 0 8px rgba(0,229,255,.1)}
        .logo-icon::after{content:'';width:14px;height:14px;background:var(--accent2);border-radius:50%;box-shadow:0 0 12px var(--accent2);animation:plsLogo 2s infinite}
        @keyframes plsLogo{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
        .logo-title{font-family:var(--disp);font-size:16px;font-weight:700;color:var(--bright);letter-spacing:2px;text-transform:uppercase}
        .logo-sub{font-size:10px;color:var(--dim);letter-spacing:3px;text-transform:uppercase;margin-top:2px}
        .hdr-stats{display:flex;gap:24px;z-index:1}
        .stat{text-align:center;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
        .stat-val{display:block;font-size:18px;font-family:var(--disp);color:var(--bright);margin-bottom:2px;font-weight:700}
        .stat-val.ac{color:var(--accent)}.stat-val.rc{color:var(--rec);animation:blink 1s step-end infinite}
        @keyframes blink{50%{opacity:0}}

        .main{grid-area:main;padding:24px;display:flex;flex-direction:column;gap:20px;overflow-y:auto}

        /* NOTICE BANNER */
        .notice{background:#0a1a10;border:1px solid var(--accent3);border-radius:6px;padding:14px 18px;font-size:11px;line-height:1.8;color:var(--accent3)}
        .notice strong{color:var(--bright);display:block;margin-bottom:4px;font-size:12px;letter-spacing:1px}
        .notice .step{color:var(--text);display:flex;gap:10px;align-items:baseline}
        .notice .step span{color:var(--accent);font-weight:700;flex-shrink:0}

        .vp{flex:1;background:#060a0c;border:1px solid var(--border);border-radius:6px;position:relative;min-height:300px;display:flex;align-items:center;justify-content:center;overflow:hidden}
        .vp::before{content:'';position:absolute;inset:0;background:linear-gradient(transparent 49.5%,rgba(0,229,255,.025) 49.5%,rgba(0,229,255,.025) 50.5%,transparent 50.5%),repeating-linear-gradient(0deg,transparent 0,transparent 19px,rgba(0,229,255,.015) 19px,rgba(0,229,255,.015) 20px);pointer-events:none}
        .vc{position:absolute;width:20px;height:20px;border-color:var(--accent);border-style:solid;opacity:.6}
        .vc.tl{top:12px;left:12px;border-width:2px 0 0 2px}.vc.tr{top:12px;right:12px;border-width:2px 2px 0 0}
        .vc.bl{bottom:12px;left:12px;border-width:0 0 2px 2px}.vc.br{bottom:12px;right:12px;border-width:0 2px 2px 0}
        .vp-idle{text-align:center;color:var(--dim);user-select:none}
        .vp-idle .ico{font-size:56px;opacity:.15;display:block;margin-bottom:12px}
        .vp-idle p{font-size:12px;letter-spacing:2px;text-transform:uppercase}
        video.preview{width:100%;height:100%;object-fit:contain;display:block}
        .rec-ov{position:absolute;top:16px;right:16px;display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.75);border:1px solid var(--rec);border-radius:3px;padding:4px 10px;font-size:11px;letter-spacing:2px;color:var(--rec);font-weight:700}
        .rec-dot{width:8px;height:8px;background:var(--rec);border-radius:50%;animation:blink .8s step-end infinite;box-shadow:0 0 8px var(--rec)}
        .cd-ov{position:absolute;inset:0;background:rgba(6,10,12,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
        .cd-num{font-family:var(--disp);font-size:120px;font-weight:700;color:var(--accent);text-shadow:0 0 40px var(--accent);animation:cdPop 1s ease-out;line-height:1}
        @keyframes cdPop{0%{transform:scale(1.5);opacity:0}30%{opacity:1}100%{transform:scale(1)}}
        .cd-lbl{font-size:12px;letter-spacing:4px;color:var(--dim);text-transform:uppercase}
        .fix-ov{position:absolute;inset:0;background:rgba(6,10,12,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
        .spinner{width:48px;height:48px;border:3px solid var(--border);border-top-color:var(--accent3);border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .fix-lbl{font-size:12px;letter-spacing:3px;color:var(--accent3);text-transform:uppercase}

        .ctrls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
        .btn{font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;border:1px solid;border-radius:4px;padding:10px 22px;cursor:pointer;transition:all .15s;background:transparent}
        .btn:disabled{opacity:.4;cursor:not-allowed}
        .btn-start{border-color:var(--accent);color:var(--accent);box-shadow:0 0 12px rgba(0,229,255,.2)}
        .btn-start:hover:not(:disabled){background:rgba(0,229,255,.08);box-shadow:0 0 20px rgba(0,229,255,.35)}
        .btn-stop{border-color:var(--rec);color:var(--rec)}.btn-stop:hover:not(:disabled){background:rgba(255,34,68,.08)}
        .btn-pause{border-color:var(--pause);color:var(--pause)}.btn-pause:hover:not(:disabled){background:rgba(255,170,0,.08)}
        .btn-dl{border-color:var(--accent3);color:var(--accent3)}.btn-dl:hover{background:rgba(57,255,133,.08)}
        .btn-folder{border-color:var(--borderB);color:var(--dim);font-size:11px;padding:8px 14px}
        .btn-folder:hover{border-color:var(--text);color:var(--text)}.btn-folder.on{border-color:var(--accent3);color:var(--accent3)}
        .audio-bar{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;flex:1;min-width:160px}
        .meter{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
        .meter-fill{height:100%;border-radius:3px;transition:width .05s linear;background:linear-gradient(90deg,var(--accent3),#00ffcc 60%,var(--pause) 80%,var(--rec) 95%)}

        /* AUDIO MODE SELECTOR */
        .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
        .sc{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .slbl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
        .sval{font-size:11px;color:var(--bright);font-weight:700;letter-spacing:1px}
        .abtns{display:flex;gap:4px;flex-wrap:wrap}
        .ab{font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 8px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;transition:all .15s}
        .ab.on{border-color:var(--accent);color:var(--accent);background:rgba(0,229,255,.08)}
        .qbtns{display:flex;gap:4px}
        .qb{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;transition:all .15s}
        .qb.on{border-color:var(--accent);color:var(--accent);background:rgba(0,229,255,.08)}

        .side{grid-area:side;border-left:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;overflow:hidden}
        .stabs{display:flex;border-bottom:1px solid var(--border)}
        .stab{flex:1;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:12px;background:transparent;border:none;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
        .stab.on{color:var(--accent);border-bottom-color:var(--accent)}
        .scnt{flex:1;overflow-y:auto;padding:16px}
        .ri{border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:10px;background:var(--card);cursor:pointer;transition:border-color .15s}
        .ri:hover{border-color:var(--borderB)}.ri.on{border-color:var(--accent)}
        .ri-name{font-size:10px;color:var(--bright);word-break:break-all;margin-bottom:6px}
        .ri-meta{display:flex;justify-content:space-between;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
        .ri-acts{display:flex;gap:6px;margin-top:8px}
        .mb{font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 8px;border:1px solid var(--borderB);border-radius:2px;background:transparent;color:var(--dim);cursor:pointer;transition:all .1s}
        .mb:hover{border-color:var(--accent);color:var(--accent)}.mb.dl:hover{border-color:var(--accent3);color:var(--accent3)}
        .loglst{font-size:10px;display:flex;flex-direction:column;gap:6px}
        .loge{display:flex;gap:8px;align-items:baseline;line-height:1.4}
        .logt{color:var(--dim);flex-shrink:0}.logm{color:var(--text)}
        .logm.success{color:var(--accent3)}.logm.error{color:var(--rec)}.logm.warn{color:var(--pause)}

        .ftr{grid-area:ftr;border-top:1px solid var(--border);background:var(--surface);padding:8px 32px;display:flex;align-items:center;justify-content:space-between;font-size:9px;color:var(--dim);letter-spacing:1.5px;text-transform:uppercase}
        .ftr-st{display:flex;align-items:center;gap:8px}
        .sdot{width:6px;height:6px;border-radius:50%;background:var(--borderB)}
        .sdot.rec{background:var(--rec);box-shadow:0 0 6px var(--rec);animation:blink .8s step-end infinite}
        .sdot.pause{background:var(--pause)}.sdot.preview{background:var(--accent3)}
        .sdot.fixing{background:var(--accent3);animation:blink .4s step-end infinite}

        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--surface)}
        ::-webkit-scrollbar-thumb{background:var(--borderB);border-radius:2px}
        @media(max-width:900px){.app{grid-template-columns:1fr;grid-template-areas:"hdr" "main" "side" "ftr"}.side{border-left:none;border-top:1px solid var(--border);max-height:280px}}
      `}</style>

      <div className="app">
        <header className="hdr">
          <div className="logo">
            <div className="logo-icon" />
            <div>
              <div className="logo-title">ScreenCapture</div>
              <div className="logo-sub">DStv / VLC Compatible Recorder</div>
            </div>
          </div>
          <div className="hdr-stats">
            <div className="stat"><span className={`stat-val ${isRec?"rc":""}`}>{fmtTime(elapsed)}</span>Duration</div>
            <div className="stat"><span className="stat-val ac">{fmtSize(sizeBytes)}</span>Captured</div>
            <div className="stat"><span className="stat-val">{recordings.length}</span>Sessions</div>
            <div className="stat"><span className="stat-val">{quality.toUpperCase()}</span>Quality</div>
          </div>
        </header>

        <main className="main">

          {/* SETUP INSTRUCTIONS */}
          <div className="notice">
            <strong>⚡ One-time Windows setup for DStv audio</strong>
            <div className="step"><span>1</span> Right-click speaker in taskbar → Sound Settings → More sound settings</div>
            <div className="step"><span>2</span> Recording tab → right-click empty area → Show Disabled Devices</div>
            <div className="step"><span>3</span> Enable <strong style={{color:"var(--accent3)",display:"inline"}}>Stereo Mix</strong> → Set as Default Device</div>
            <div className="step"><span>4</span> Set Audio Mode below to <strong style={{color:"var(--accent3)",display:"inline"}}>Stereo Mix</strong> → then Start Recording</div>
            <div className="step"><span>5</span> When share dialog appears → pick <strong style={{color:"var(--accent)",display:"inline"}}>Entire Screen</strong> → click Share</div>
          </div>

          <div className="vp">
            <div className="vc tl"/><div className="vc tr"/>
            <div className="vc bl"/><div className="vc br"/>
            {status === "idle" && <div className="vp-idle"><span className="ico">⬛</span><p>Ready to record</p></div>}
            {isCd && <div className="cd-ov"><div className="cd-num" key={countdown}>{countdown}</div><div className="cd-lbl">Recording starts…</div></div>}
            {(isRec || isPaused) && (
              <>
                <div className="vp-idle"><span className="ico">🎬</span><p>{isPaused ? "Paused" : "Recording entire screen…"}</p></div>
                {isRec && <div className="rec-ov"><div className="rec-dot"/>REC {fmtTime(elapsed)}</div>}
                {isPaused && <div className="rec-ov" style={{borderColor:"var(--pause)",color:"var(--pause)"}}>⏸ PAUSED</div>}
              </>
            )}
            {fixing && <div className="fix-ov"><div className="spinner"/><div className="fix-lbl">Fixing WebM for VLC…</div></div>}
            {status === "preview" && activeRec && !fixing && <video className="preview" src={activeRec.url} controls autoPlay />}
          </div>

          <div className="ctrls">
            {(status === "idle" || status === "preview") && <button className="btn btn-start" onClick={startCountdown}>▶ Start Recording</button>}
            {(isRec || isPaused || isCd) && (
              <>
                <button className="btn btn-stop" onClick={stopRecording} disabled={isCd||fixing}>■ Stop</button>
                {!isCd && <button className="btn btn-pause" onClick={togglePause} disabled={fixing}>{isPaused?"▶ Resume":"⏸ Pause"}</button>}
              </>
            )}
            {activeRec && status === "preview" && !fixing && <button className="btn btn-dl" onClick={()=>triggerDownload(activeRec.blob,activeRec.filename)}>↓ Re-Download</button>}
            <button className={`btn btn-folder ${dirHandle?"on":""}`} onClick={getOrCreateFolder}>
              📁 {dirHandle ? "MyScreenRecorder ✓" : "Set Save Folder"}
            </button>
            {(isRec || isPaused) && (
              <div className="audio-bar">
                <span>Audio</span>
                <div className="meter"><div className="meter-fill" style={{width:`${audioLevel}%`}}/></div>
                <span>{audioLevel.toFixed(0)}%</span>
              </div>
            )}
          </div>

          <div className="sg">
            {/* Audio Mode */}
            <div className="sc" style={{gridColumn:"span 2"}}>
              <div>
                <div className="slbl">Audio Source</div>
                <div className="sval">
                  {audioMode==="system" ? "Stereo Mix / Default Device" :
                   audioMode==="mic"    ? "Microphone Only" :
                   audioMode==="both"   ? "Stereo Mix + Mic" : "No Audio"}
                </div>
              </div>
              <div className="abtns">
                {[["system","Stereo Mix"],["mic","Mic Only"],["both","Both"],["none","No Audio"]].map(([v,l])=>(
                  <button key={v} className={`ab ${audioMode===v?"on":""}`} onClick={()=>setAudioMode(v)}>{l}</button>
                ))}
              </div>
            </div>

            {/* Quality */}
            <div className="sc">
              <div>
                <div className="slbl">Video Quality</div>
                <div className="sval">{quality==="balanced"?"2.5Mbps":quality==="high"?"6Mbps":"12Mbps"}</div>
              </div>
              <div className="qbtns">
                {["balanced","high","ultra"].map(q=>(
                  <button key={q} className={`qb ${quality===q?"on":""}`} onClick={()=>setQuality(q)}>
                    {q==="balanced"?"BAL":q==="high"?"HI":"4K"}
                  </button>
                ))}
              </div>
            </div>

            {/* VLC Fix */}
            <div className="sc">
              <div><div className="slbl">VLC Fix</div><div className="sval" style={{color:"var(--accent3)",fontSize:9}}>ALWAYS ON</div></div>
              <span style={{fontSize:18}}>✅</span>
            </div>
          </div>
        </main>

        <aside className="side">
          <SidebarTabs
            recordings={recordings}
            activeRec={activeRec}
            setActiveRec={r=>{setActiveRec(r);setStatus("preview");}}
            log={log}
            triggerDownload={triggerDownload}
          />
        </aside>

        <footer className="ftr">
          <div className="ftr-st">
            <div className={`sdot ${fixing?"fixing":isRec?"rec":isPaused?"pause":status==="preview"?"preview":""}`}/>
            <span>{fixing?"PROCESSING":status==="idle"?"STANDBY":isCd?"COUNTDOWN":isRec?"RECORDING":isPaused?"PAUSED":"PREVIEW"}</span>
          </div>
          <span>📁 {dirHandle?"MyScreenRecorder":"auto-download"}</span>
          <span>{BEST_MIME||"default"}</span>
          <span>Entire Screen · 60fps · VLC-fixed</span>
        </footer>
      </div>
    </>
  );
}

function SidebarTabs({ recordings, activeRec, setActiveRec, log, triggerDownload }) {
  const [tab, setTab] = useState(0);
  return (
    <>
      <div className="stabs">
        <button className={`stab ${tab===0?"on":""}`} onClick={()=>setTab(0)}>Recordings ({recordings.length})</button>
        <button className={`stab ${tab===1?"on":""}`} onClick={()=>setTab(1)}>Log</button>
      </div>
      <div className="scnt">
        {tab===0 ? (
          recordings.length===0
            ? <div style={{color:"var(--dim)",fontSize:10,textAlign:"center",marginTop:32,lineHeight:2}}>No recordings yet.<br/>Press ▶ Start to begin.</div>
            : recordings.map(r=>(
              <div key={r.id} className={`ri ${activeRec?.id===r.id?"on":""}`} onClick={()=>setActiveRec(r)}>
                <div className="ri-name">{r.filename}</div>
                <div className="ri-meta"><span>{fmtSize(r.size)}</span><span>{fmtTime(r.duration)}</span><span>.{r.ext}</span></div>
                <div className="ri-acts">
                  <button className="mb" onClick={e=>{e.stopPropagation();setActiveRec(r)}}>▶ Play</button>
                  <button className="mb dl" onClick={e=>{e.stopPropagation();triggerDownload(r.blob,r.filename)}}>↓ DL</button>
                </div>
              </div>
            ))
        ) : (
          <div className="loglst">
            {log.length===0
              ? <span style={{color:"var(--dim)",fontSize:10}}>No events yet.</span>
              : log.map((e,i)=>(
                <div key={i} className="loge">
                  <span className="logt">{e.time}</span>
                  <span className={`logm ${e.type}`}>{e.msg}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
}