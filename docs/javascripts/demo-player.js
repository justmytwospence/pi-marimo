// The demo video on the home page plays like a GIF (autoplay, loop, muted, no player chrome) with a
// thin timeline under it: click or drag to jump, arrow keys step five seconds, Space or a click on
// the video pauses. Ticks mark where each caption starts (docs/assets/demo.json, from
// demo/annotate.py). Material's instant navigation swaps pages without reloading, so set up on
// every page load.
function setupDemoPlayer(figure) {
  if (figure.dataset.ready) return;
  figure.dataset.ready = "true";
  const video = figure.querySelector("video");
  const bar = figure.querySelector(".demo-scrub");
  const fill = bar.querySelector(".demo-scrub-fill");
  const label = figure.querySelector(".demo-chapter");
  let chapters = [];
  let dragging = false;
  let resume = false;

  const fraction = (event) => {
    const box = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };
  const seek = (event) => {
    if (video.duration) video.currentTime = fraction(event) * video.duration;
  };
  const chapterAt = (time) => chapters.filter((c) => c.time <= time + 0.05).pop();
  const draw = () => {
    if (video.duration) {
      const done = video.currentTime / video.duration;
      fill.style.width = `${done * 100}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(video.currentTime)));
      const chapter = chapterAt(video.currentTime);
      if (label && chapter && label.textContent !== chapter.title) label.textContent = chapter.title;
    }
    requestAnimationFrame(draw);
  };

  bar.addEventListener("pointerdown", (event) => {
    dragging = true;
    resume = !video.paused;
    video.pause();
    try { bar.setPointerCapture(event.pointerId); } catch { /* Synthetic or already-released pointers. */ }
    seek(event);
  });
  bar.addEventListener("pointermove", (event) => {
    if (dragging) seek(event);
    const chapter = video.duration ? chapterAt(fraction(event) * video.duration) : undefined;
    bar.title = chapter ? chapter.title : "";
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    if (resume) void video.play();
  };
  bar.addEventListener("pointerup", release);
  bar.addEventListener("pointercancel", release);
  bar.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") video.currentTime = Math.min(video.duration, video.currentTime + 5);
    else if (event.key === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 5);
    else if (event.key === " ") video.paused ? void video.play() : video.pause();
    else return;
    event.preventDefault();
  });
  video.addEventListener("click", () => (video.paused ? void video.play() : video.pause()));
  video.addEventListener("loadedmetadata", () => bar.setAttribute("aria-valuemax", String(Math.round(video.duration))));

  const addTicks = () => {
    if (!video.duration || !chapters.length || bar.querySelector(".demo-scrub-tick")) return;
    for (const chapter of chapters.slice(1)) {
      const tick = document.createElement("span");
      tick.className = "demo-scrub-tick";
      tick.style.left = `${(chapter.time / video.duration) * 100}%`;
      bar.appendChild(tick);
    }
  };
  fetch(figure.dataset.chapters)
    .then((response) => response.json())
    .then((list) => { chapters = list; addTicks(); })
    .catch(() => {});
  video.addEventListener("loadedmetadata", addTicks);
  if (video.readyState >= 1) addTicks();
  requestAnimationFrame(draw);
}

const setupDemoPlayers = () => document.querySelectorAll(".demo-player").forEach(setupDemoPlayer);
if (typeof document$ !== "undefined") document$.subscribe(setupDemoPlayers);
else document.addEventListener("DOMContentLoaded", setupDemoPlayers);
