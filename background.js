// background.js
// ツールバーアイコンをクリックしたら、専用タブを開く(既に開いていれば
// そのタブに切り替える)。ポップアップ内でファイル選択ダイアログを開くと
// ポップアップが閉じてしまう問題を避けるため、UI全体をタブ内ページとして
// 提供する。

const PAGE_URL = browser.runtime.getURL("page.html");

browser.action.onClicked.addListener(async () => {
  const existingTabs = await browser.tabs.query({});
  const target = existingTabs.find((t) => t.url === PAGE_URL);

  if (target) {
    await browser.tabs.update(target.id, { active: true });
    await browser.windows.update(target.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: PAGE_URL });
  }
});
