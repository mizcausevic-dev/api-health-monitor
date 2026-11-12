// Runs before first paint (blocking, tiny) so a saved theme never flashes.
(function () {
  var d = document.documentElement;
  var theme = null;
  var scheme = null;
  try {
    theme = localStorage.getItem('ahm.theme');
    scheme = localStorage.getItem('ahm.scheme');
  } catch (e) { /* storage blocked: fall back to defaults */ }
  // ?theme=swiss&scheme=light previews a theme without saving it.
  var q = new URLSearchParams(location.search);
  if (/^(bento|cosmic|swiss|aqua|brutalist|steel|parchment)$/.test(q.get('theme') || '')) theme = q.get('theme');
  if (/^(light|dark)$/.test(q.get('scheme') || '')) scheme = q.get('scheme');
  if (!scheme) scheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  d.setAttribute('data-theme', theme || 'bento');
  d.setAttribute('data-scheme', scheme);
})();
