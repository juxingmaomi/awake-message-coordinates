(async () => {
  const REPO = 'juxingmaomi/awake-message-coordinates';
  const VERSION = 'v1.1.0';
  const URL = `https://gcore.jsdelivr.net/gh/${REPO}@${VERSION}/index.js`;

  const loaderState = {
    repo: REPO,
    requestedTag: VERSION,
    url: URL,
    requestedAt: new Date().toISOString(),
  };
  window.__XW_AWAKE_MESSAGE_COORDINATES_LOADER__ = loaderState;

  function popup(type, message) {
    try {
      const toastr = window.toastr || (window.parent && window.parent.toastr);
      if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, '消息编号与清醒周期');
        return;
      }
    } catch (_) {}
    if (type === 'error') alert(message);
    else console.log(`[awake-message-coordinates] ${message}`);
  }

  try {
    await import(URL);
    const loadedVersion = window.__XW_AWAKE_MESSAGE_COORDINATES_CORE__?.version;
    if (loadedVersion !== VERSION) {
      throw new Error(`版本校验失败：请求 ${VERSION}，实际 ${loadedVersion || '未知'}`);
    }
    loaderState.loadedTag = loadedVersion;
    loaderState.loadedAt = new Date().toISOString();
    popup('success', `纯显示版已加载 ${loadedVersion}`);
  } catch (error) {
    loaderState.error = String(error && error.message || error);
    console.error('[awake-message-coordinates] Load failed.', error);
    popup('error', `纯显示版 ${VERSION} 加载失败。请确认 GitHub 已发布该版本。`);
  }
})();
