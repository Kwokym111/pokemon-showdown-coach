// panel-live.js: the #live section of the panel. Faysal's file.
// It only displays what main sent over IPC (rule 1); all the work happens in the main process.

const PLACEHOLDER = 'Live info: waiting for a battle';
const liveEl = document.getElementById('live');

// data is { room, info }. info === null means "nothing to show / clear".
window.panelAPI.onLiveInfo(({ room, info }) => {
  // textContent, never innerHTML: the room id comes from the server.
  if (info === null) {
    liveEl.textContent = PLACEHOLDER;
    return;
  }
  // Stub display, replace with the real thing.
  liveEl.textContent = `Live info: ${info.linesSeen} lines seen in ${room}`;
});
