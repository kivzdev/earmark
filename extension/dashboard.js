// On Earmark's own dashboard (the helper's page on this computer): when you allow the extension there, wake the
// background script so it picks up its token right away, even if Chrome had put it to sleep while you were deciding.
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin) return
  if (e.data?.source === 'earmark-dashboard' && e.data.type === 'paired') {
    chrome.runtime.sendMessage({ t: 'paired' }).catch(() => {})
  }
})
