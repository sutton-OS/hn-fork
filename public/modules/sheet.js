export function wireSheetDrag(header, panel, close) {
  let gesture;
  header.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest("a,button")) return;
    gesture = { id: event.pointerId, start: event.clientY, previous: event.clientY, at: event.timeStamp, speed: 0 };
    header.setPointerCapture(event.pointerId);
    panel.classList.add("is-dragging");
  };
  header.onpointermove = event => {
    if (gesture?.id !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - gesture.start);
    const elapsed = event.timeStamp - gesture.at;
    if (elapsed > 0) gesture.speed = (event.clientY - gesture.previous) / elapsed;
    gesture.at = event.timeStamp;
    gesture.previous = event.clientY;
    panel.style.transform = "translateY(" + distance + "px)";
  };
  header.onpointerup = event => {
    if (gesture?.id !== event.pointerId) return;
    const distance = event.clientY - gesture.start;
    const flick = distance > 24 && gesture.speed > 0.65 && event.timeStamp - gesture.at < 100;
    if (distance > 120 || flick) close();
    header.releasePointerCapture(event.pointerId);
  };
  header.onlostpointercapture = () => {
    gesture = null;
    panel.classList.remove("is-dragging");
    panel.style.removeProperty("transform");
  };
}

export function lockSheetScroll() {
  const x = window.scrollX;
  const y = window.scrollY;
  document.body.style.setProperty("--preview-scroll-top", -y + "px");
  document.body.classList.add("preview-open");
  return () => {
    document.body.classList.remove("preview-open");
    document.body.style.removeProperty("--preview-scroll-top");
    window.scrollTo({ left: x, top: y, behavior: "instant" });
  };
}

export function closeOpenSheet() {
  const dialog = document.querySelector(".preview-dialog[open]");
  if (!dialog) return Promise.resolve();
  return new Promise(resolve => {
    dialog.addEventListener("close", resolve, { once: true });
    dialog.dispatchEvent(new Event("hnx-close-sheet"));
  });
}
