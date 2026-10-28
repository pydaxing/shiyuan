export function createFieldReveal({ isActive, measureViewport, reveal, cancelScroll, scrollVersion = () => 0, schedule = setTimeout, unschedule = clearTimeout }) {
  let field = null;
  let timer;
  let revision = 0;
  let interrupted = false;
  function cancel() {
    unschedule(timer);
    timer = undefined;
    revision += 1;
    cancelScroll();
  }
  function request(delay = 60) {
    cancel();
    if (!field || interrupted || !isActive()) return;
    const current = revision;
    const valid = () => current === revision && isActive();
    timer = schedule(() => {
      if (!valid()) return;
      const measuredVersion = scrollVersion();
      field.measure((bounds) => {
        if (!valid()) return;
        measureViewport((viewport) => {
          if (!valid()) return;
          if (scrollVersion() !== measuredVersion) { request(); return; }
          Promise.resolve(reveal(bounds, viewport)).then(applied => {
            if (applied === false && valid() && !interrupted) request();
          });
        });
      });
    }, delay);
  }
  function focus(token, measure, delay = 60) { cancel(); field = { token, measure }; interrupted = false; if (delay !== null) request(delay); }
  function blur(token) { if (field?.token === token) { field = null; cancel(); } }
  function interrupt() { interrupted = true; cancel(); }
  function clear() { field = null; cancel(); }
  return { focus, blur, request, interrupt, clear, cancel, owns: (token) => field?.token === token };
}
