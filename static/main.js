// Simple front-end controller for the Flask SSE stream.

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
    '<span class="inline-highlight">$1<\/span>'
  );
}

// TODO: Put your YouTube embed URL here. For example, if your watch URL is
//   https://www.youtube.com/watch?v=VIDEO_ID
// then set:
//   const YOUTUBE_EMBED_URL = "https://www.youtube.com/embed/VIDEO_ID?autoplay=1";
// The JS will assign this to the iframe when Start Session is clicked.
const YOUTUBE_EMBED_URL = "https://www.youtube.com/embed/cMiu3A7YBks?autoplay=1"; // <- SET THIS TO YOUR EMBED URL

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("profile-form");
  const statusEl = document.getElementById("status");
  const setupSection = document.getElementById("setup-section");
  const videoSection = document.getElementById("video-section");
  const youtubePlayer = document.getElementById("youtube-player");
  const mainLayout = document.getElementById("main-layout");
  const transcriptEl = document.getElementById("transcript");
  const commentaryListEl = document.getElementById("commentary-list");

  let eventSource = null;

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    transcriptEl.innerHTML = "";
    commentaryListEl.innerHTML = "";

    const formData = new FormData(form);
    const education = formData.get("education") || "";
    const mlBackground = formData.get("ml_background") || "";
    const weakTopics = formData.get("weak_topics") || "";
    const goal = formData.get("goal") || "";
    const speed = formData.get("speed") || "1.0";
    const commentaryStyle = formData.get("commentary_style") || "medium";

    const profile = [
      `Highest education and field: ${education}`,
      `ML/NLP/AI background: ${mlBackground}`,
      `Weaker topics: ${weakTopics}`,
      `Learning goals: ${goal}`,
    ].join("\n");

    const params = new URLSearchParams({
      transcript: "transcript.txt",
      model: "gpt-4o-mini",
      speed: String(speed),
      commentary_style: String(commentaryStyle),
      user_profile: profile,
    });

    form.querySelector("button[type='submit']").disabled = true;
    statusEl.textContent = "Starting session...";

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
        if (YOUTUBE_EMBED_URL && youtubePlayer) {
          youtubePlayer.src = YOUTUBE_EMBED_URL;
          videoSection.classList.remove("hidden");
        }
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
  });

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

    const segments = Array.from(transcriptEl.getElementsByClassName("segment"));

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
