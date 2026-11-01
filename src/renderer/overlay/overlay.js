// overlay.js: the end-of-game card's page script. It only displays what main sends it.

document.getElementById('close').addEventListener('click', () => window.review.close());

window.review.onBattleLog(({ room, log }) => {
  const turns = (log.match(/^\|turn\|/gm) || []).length;
  // textContent, not innerHTML: the room id comes from the server.
  document.getElementById('status').textContent = `${room}: ${turns} turns captured.`;
});
