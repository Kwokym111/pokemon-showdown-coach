// replay-order.js: runs BEFORE replay-embed.js (see replay.html).
//
// replay-embed.js loads jQuery, battle.js and the data files by appending <script> tags
// from code. Scripts added that way are "async" by default: each runs as soon as it
// downloads, in whatever order. Now and then a script that needs jQuery runs before jQuery
// does ("$ is not defined") and the replay never starts. Setting async = false makes the
// browser still download them in parallel but run them in the order they were added, which
// is the order Showdown lists them in (jQuery first). Only our own replay page is affected.
const realAppend = document.head.appendChild.bind(document.head);
document.head.appendChild = (node) => {
  if (node && node.tagName === 'SCRIPT') node.async = false;
  return realAppend(node);
};
