// The browser chooses the snap position. Never cancel an input or synthesize a scroll.
// Chrome proximity snap can keep returning to the same point on small wheel gestures:
// after resting at the room, a new departure gesture temporarily releases that point.
export function installRoomSnap(room) {
  const root = document.documentElement;
  let free = true, lastWheel = -Infinity, lastY = scrollY, inputDirection = 0, touch = null;
  const offset = () => room.getBoundingClientRect().top - (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0);
  const clear = () => { free = false; root.classList.remove("room-snap-free"); };
  const depart = () => { free = true; root.classList.add("room-snap-free"); };
  const rested = (beforeScroll = false) => Math.abs(offset() + (beforeScroll ? scrollY - lastY : 0)) < 3;
  const approachOrDepart = (direction, newGesture = true, wasAtRoom = rested()) => {
    if (!direction) return;
    inputDirection = direction;
    if (!free && newGesture && wasAtRoom) depart();
  };
  addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX) || e.ctrlKey || e.target?.closest?.("#log")) return;
    const now = performance.now();
    // Passive wheel events can arrive after compositor scrolling; use the preceding scroll position.
    approachOrDepart(Math.sign(e.deltaY), now - lastWheel > 180, rested(true));
    lastWheel = now;
  }, { passive: true });
  addEventListener("scroll", () => {
    const direction = Math.sign(scrollY - lastY); lastY = scrollY;
    if (!free) return;
    const d = offset();
    // Restore only when approaching the room closely again. Restoring while reading
    // can make browsers re-snap to an old target after a layout change.
    if (direction === inputDirection && d * direction > 0 && Math.abs(d) < innerHeight * 0.25) clear();
  }, { passive: true });
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (e.target?.closest?.("input,button,a,[role=button],#log")) return;
    if (e.target?.id === "stage" && !["PageDown", "PageUp", "Home", "End"].includes(e.code)) return;
    const direction = { PageDown: 1, ArrowDown: 1, End: 1, PageUp: -1, ArrowUp: -1, Home: -1, Space: e.shiftKey ? -1 : 1 }[e.code];
    approachOrDepart(direction, !e.repeat);
  });
  addEventListener("pointerdown", (e) => {
    touch = e.pointerType === "touch" && !e.target?.closest?.("#log,input,button,a") && !room.classList.contains("interacting")
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, rested: rested() } : null;
  }, { passive: true });
  addEventListener("pointermove", (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      approachOrDepart(-Math.sign(dy), true, touch.rested); touch = null;
    }
  }, { passive: true });
  for (const event of ["pointerup", "pointercancel"]) addEventListener(event, () => { touch = null; }, { passive: true });
  document.addEventListener("click", (e) => { if (e.target?.closest?.('a[href="#room"]')) clear(); });
  // Start released: the short header and long text have no snap points.
  root.classList.add("room-snap-on", "room-snap-free");
}
