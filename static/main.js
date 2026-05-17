// Front-end controller for Faro.
//
// Supports two modes selected via the form:
// - "recorded": replays a timestamped transcript.txt via SSE (/stream)
// - "live": uses browser SpeechRecognition and calls /api/commentary

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function convertHighlightMarkers(text) {
  // Turn <<H>>...<</H>> into inline-highlight spans for display
  return escapeHtml(text).replace(
    /&lt;&lt;H&gt;&gt;(.*?)&lt;&lt;\/H&gt;&gt;/gs,
    '<span class="inline-highlight">$1<\/span>',
  );
}

// TODO: Put your YouTube embed URL here. For example, if your watch URL is
//   https://www.youtube.com/watch?v=VIDEO_ID
// then set:
//   const YOUTUBE_EMBED_URL = "https://www.youtube.com/embed/VIDEO_ID?autoplay=1";
// The JS will assign this to the iframe when Start Session is clicked.
// const YOUTUBE_EMBED_URL =
//   "https://www.youtube.com/embed/cMiu3A7YBks?autoplay=1"; // <- SET THIS TO YOUR EMBED URL

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("profile-form");
  const statusEl = document.getElementById("status");
  const setupSection = document.getElementById("setup-section");
  const videoSection = document.getElementById("video-section");
  const youtubePlayer = document.getElementById("youtube-player");
  const mainLayout = document.getElementById("main-layout");
  const transcriptEl = document.getElementById("transcript");
  const commentaryListEl = document.getElementById("commentary-list");
  const pauseBtn = document.getElementById("pause-live");
  const resumeBtn = document.getElementById("resume-live");
  const stopBtn = document.getElementById("stop-live");
  const downloadTranscriptBtn = document.getElementById("download-transcript");
  const downloadCommentaryBtn = document.getElementById("download-commentary");

  let eventSource = null;
  let recognition = null;
  let shouldKeepListening = false;
  let isRecognitionRunning = false;
  let sessionStartMs = null;
  let liveSegments = []; // { startSeconds, rawTimestamp, text }
  let liveCommentaryEvents = []; // { timestamp, text }
  let isLiveMode = false;
  let currentProfile = "";
  let currentCommentaryStyle = "medium";
  let currentModel = "gpt-4o-mini";
  let commentaryRequestInFlight = false;

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const education = formData.get("education") || "";
    const mlBackground = formData.get("ml_background") || "";
    const weakTopics = formData.get("weak_topics") || "";
    const goal = formData.get("goal") || "";
    const speed = formData.get("speed") || "1.0";
    const commentaryStyle = formData.get("commentary_style") || "medium";
    const mode = formData.get("mode") || "live";

    const profile = [
      `Highest education and field: ${education}`,
      `ML/NLP/AI background: ${mlBackground}`,
      `Weaker topics: ${weakTopics}`,
      `Learning goals: ${goal}`,
    ].join("\n");

    // Clear previous content
    transcriptEl.innerHTML = "";
    commentaryListEl.innerHTML = "";

    // Close any existing SSE stream or live recognition session.
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (recognition) {
      shouldKeepListening = false;
      try {
        recognition.stop();
      } catch (_) {
        // ignore
      }
    }

    isLiveMode = mode === "live";
    liveCommentaryEvents = [];

    form.querySelector("button[type='submit']").disabled = true;

    if (mode === "recorded") {
      startRecordedSession({ profile, speed, commentaryStyle });
      setLiveControlsEnabled(false);
    } else {
      startLiveSession({ profile, commentaryStyle });
      setLiveControlsEnabled(true);
    }
  });

  function setLiveControlsEnabled(enabled) {
    if (!pauseBtn || !resumeBtn || !stopBtn || !downloadTranscriptBtn || !downloadCommentaryBtn) return;
    const disabled = !enabled;
    pauseBtn.disabled = disabled;
    stopBtn.disabled = disabled;
    downloadTranscriptBtn.disabled = disabled;
    downloadCommentaryBtn.disabled = disabled;
    // Resume is only enabled after a pause.
    resumeBtn.disabled = true;
  }

  function startRecordedSession({ profile, speed, commentaryStyle }) {
    const params = new URLSearchParams({
      transcript: "transcript.txt",
      model: "gpt-4o-mini",
      speed: String(speed),
      commentary_style: String(commentaryStyle),
      user_profile: profile,
    });

    statusEl.textContent = "Starting recorded session...";

    eventSource = new EventSource(`/stream?${params.toString()}`);

    eventSource.onmessage = (event) => {
      if (!event.data) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        console.error("Failed to parse SSE payload", err, event.data);
        return;
      }

      if (payload.type === "started") {
        setupSection.classList.add("hidden");
        // Show and start the YouTube video if a URL has been configured.
        // if (YOUTUBE_EMBED_URL && youtubePlayer) {
        //   youtubePlayer.src = YOUTUBE_EMBED_URL;
        //   videoSection.classList.remove("hidden");
        // }
        mainLayout.classList.remove("hidden");
        statusEl.textContent = "Session running";
        return;
      }

      if (payload.type === "segment") {
        appendSegment(payload);
        return;
      }

      if (payload.type === "commentary") {
        appendCommentary(payload);
        highlightPhrases(payload.highlight_phrases || []);
        return;
      }

      if (payload.type === "error") {
        console.error("Server error event", payload);
        const msg = payload.message || "Unknown error";
        statusEl.textContent = `Error: ${msg}`;
        statusEl.classList.add("error-text");
        return;
      }

      if (payload.type === "done") {
        statusEl.textContent = "Session finished";
        form.querySelector("button[type='submit']").disabled = false;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      }
    };

    eventSource.onerror = (event) => {
      console.error("SSE connection error", event);
      statusEl.textContent = "Connection error";
      statusEl.classList.add("error-text");
      form.querySelector("button[type='submit']").disabled = false;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }

  function formatTimestamp(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  async function startLiveSession({ profile, commentaryStyle }) {
    if (!SpeechRecognition) {
      statusEl.textContent = "Speech recognition is not supported in this browser";
      statusEl.classList.add("error-text");
      form.querySelector("button[type='submit']").disabled = false;
      return;
    }

    currentProfile = profile;
    currentCommentaryStyle = String(commentaryStyle || "medium");
    currentModel = "gpt-4o-mini";
    liveSegments = [];
    sessionStartMs = Date.now();

    setupSection.classList.add("hidden");
    // if (YOUTUBE_EMBED_URL && youtubePlayer) {
    //   youtubePlayer.src = YOUTUBE_EMBED_URL;
    //   videoSection.classList.remove("hidden");
    // }
    mainLayout.classList.remove("hidden");

    statusEl.textContent = "Requesting microphone permission...";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // We immediately stop tracks; SpeechRecognition will handle audio capture.
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      statusEl.textContent = `Microphone error: ${err.message}`;
      statusEl.classList.add("error-text");
      form.querySelector("button[type='submit']").disabled = false;
      return;
    }

    configureRecognition();
    shouldKeepListening = true;
    if (!isRecognitionRunning) {
      try {
        recognition.start();
        statusEl.textContent = "Listening...";
      } catch (err) {
        statusEl.textContent = `Could not start recognition: ${err.message}`;
        statusEl.classList.add("error-text");
        form.querySelector("button[type='submit']").disabled = false;
      }
    }
  }

  function configureRecognition() {
    if (recognition) return;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isRecognitionRunning = true;
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const chunk = res[0].transcript;
        if (res.isFinal) {
          const nowSeconds = (Date.now() - sessionStartMs) / 1000;
          const rawTimestamp = formatTimestamp(nowSeconds);
          const text = chunk.trim();
          if (!text) continue;

          liveSegments.push({
            startSeconds: nowSeconds,
            rawTimestamp,
            text,
          });

          appendSegment({ timestamp: rawTimestamp, text });
          maybeRequestCommentary();
        } else {
          interim += chunk;
        }
      }

      if (interim.trim()) {
        statusEl.textContent = "Hearing speech...";
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error", event);
      statusEl.textContent = `Speech recognition error: ${event.error}`;
      statusEl.classList.add("error-text");
      shouldKeepListening = false;
      isRecognitionRunning = false;
      form.querySelector("button[type='submit']").disabled = false;
    };

    recognition.onend = () => {
      isRecognitionRunning = false;
      if (shouldKeepListening) {
        // Try a quick restart to avoid missing speech between sessions.
        window.setTimeout(() => {
          if (!shouldKeepListening || isRecognitionRunning) return;
          try {
            recognition.start();
          } catch (error) {
            console.error("Could not restart recognizer", error);
            shouldKeepListening = false;
            statusEl.textContent = "Recognizer stopped due to an error";
            statusEl.classList.add("error-text");
            form.querySelector("button[type='submit']").disabled = false;
          }
        }, 50);
      } else {
        form.querySelector("button[type='submit']").disabled = false;
      }
    };
  }

  async function maybeRequestCommentary() {
    if (commentaryRequestInFlight || !liveSegments.length) return;
    commentaryRequestInFlight = true;

    const last = liveSegments[liveSegments.length - 1];
    const cutoff = last.startSeconds - 90.0;
    const windowSegments = liveSegments.filter(
      (s) => s.startSeconds >= cutoff,
    );

    // Map to the shape expected by the backend API.
    const apiSegments = windowSegments.map((s) => ({
      start_seconds: s.startSeconds,
      raw_timestamp: s.rawTimestamp,
      text: s.text,
    }));

    try {
      const resp = await fetch("/api/commentary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: apiSegments,
          user_profile: currentProfile,
          commentary_style: currentCommentaryStyle,
          model: currentModel,
        }),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      if (data.need_commentary && data.commentary) {
        const ts = data.timestamp || last.rawTimestamp;
        appendCommentary({
          timestamp: ts,
          text: data.commentary,
          highlight_phrases: data.highlight_phrases || [],
        });
        liveCommentaryEvents.push({ timestamp: ts, text: data.commentary });
        highlightPhrases(data.highlight_phrases || []);
      }
    } catch (err) {
      console.error("Commentary API error", err);
      statusEl.textContent = "Error generating commentary";
      statusEl.classList.add("error-text");
    } finally {
      commentaryRequestInFlight = false;
    }
  }

  function downloadText(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      if (!isLiveMode) return;
      shouldKeepListening = false;
      if (recognition && isRecognitionRunning) {
        try {
          recognition.stop();
        } catch (_) {}
      }
      statusEl.textContent = "Listening paused";
      pauseBtn.disabled = true;
      if (resumeBtn) resumeBtn.disabled = false;
    });
  }

  if (resumeBtn) {
    resumeBtn.addEventListener("click", () => {
      if (!isLiveMode) return;
      if (!SpeechRecognition) return;
      shouldKeepListening = true;
      configureRecognition();
      if (!isRecognitionRunning && recognition) {
        try {
          recognition.start();
          statusEl.textContent = "Listening...";
        } catch (err) {
          console.error("Could not resume recognition", err);
          statusEl.textContent = `Could not resume recognition: ${err.message}`;
          statusEl.classList.add("error-text");
        }
      }
      resumeBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = false;
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (!isLiveMode) return;
      shouldKeepListening = false;
      if (recognition && isRecognitionRunning) {
        try {
          recognition.stop();
        } catch (_) {}
      }
      statusEl.textContent = "Live session stopped";
      form.querySelector("button[type='submit']").disabled = false;
      setLiveControlsEnabled(false);
    });
  }

  if (downloadTranscriptBtn) {
    downloadTranscriptBtn.addEventListener("click", () => {
      if (!liveSegments.length) {
        alert("No transcript available yet.");
        return;
      }
      const lines = liveSegments.map(
        (s) => `[${s.rawTimestamp}] ${s.text}`,
      );
      downloadText("faro_transcript.txt", lines.join("\n"));
    });
  }

  if (downloadCommentaryBtn) {
    downloadCommentaryBtn.addEventListener("click", () => {
      if (!liveCommentaryEvents.length) {
        alert("No commentary available yet.");
        return;
      }
      const chunks = liveCommentaryEvents.map(
        (c) => `[${c.timestamp}]\n${c.text}`,
      );
      downloadText("faro_commentary.txt", chunks.join("\n\n"));
    });
  }

  function appendSegment(payload) {
    const wrapper = document.createElement("div");
    wrapper.className = "segment";

    const tsSpan = document.createElement("span");
    tsSpan.className = "timestamp";
    tsSpan.textContent = `[${payload.timestamp}]`;

    const textSpan = document.createElement("span");
    textSpan.className = "text";
    textSpan.textContent = ` ${payload.text}`;

    wrapper.appendChild(tsSpan);
    wrapper.appendChild(textSpan);
    transcriptEl.appendChild(wrapper);

    // Keep the latest content in view
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function appendCommentary(payload) {
    const bubble = document.createElement("div");
    bubble.className = "commentary-bubble";

    const header = document.createElement("div");
    header.className = "commentary-header";

    const tsSpan = document.createElement("span");
    tsSpan.className = "timestamp";
    tsSpan.textContent = `[${payload.timestamp}]`;

    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Click to expand/collapse";

    header.appendChild(tsSpan);
    header.appendChild(hint);

    const body = document.createElement("div");
    body.className = "commentary-body";

    const bodyInner = document.createElement("div");
    bodyInner.className = "commentary-body-inner";
    bodyInner.innerHTML = convertHighlightMarkers(payload.text || "");

    body.appendChild(bodyInner);

    bubble.appendChild(header);
    bubble.appendChild(body);

    bubble.addEventListener("click", () => {
      bubble.classList.toggle("expanded");
    });

    commentaryListEl.appendChild(bubble);
    commentaryListEl.scrollTop = commentaryListEl.scrollHeight;
  }

  function highlightPhrases(phrases) {
    if (!phrases || !phrases.length) return;

    const segments = Array.from(
      transcriptEl.getElementsByClassName("segment"),
    );

    phrases.forEach((phrase) => {
      if (!phrase) return;

      for (const seg of segments) {
        const textSpan = seg.querySelector(".text");
        if (!textSpan) continue;

        const raw = textSpan.textContent || "";
        const idx = raw.indexOf(phrase);
        if (idx === -1) continue;

        const before = escapeHtml(raw.slice(0, idx));
        const match = escapeHtml(phrase);
        const after = escapeHtml(raw.slice(idx + phrase.length));

        textSpan.innerHTML = `${before}<span class="highlight">${match}</span>${after}`;
        break; // highlight first occurrence only
      }
    });
  }
});

