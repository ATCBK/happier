import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} 可使用`,
      taken: ({ username }: { username: string }) => `@${username} 已被使用`,
      reserved: ({ username }: { username: string }) => `@${username} 在此服務上為保留名稱`,
      invalid: '此服務不允許使用該使用者名稱。',
      suggestions: '可改用',
      checkFailed: '無法檢查此使用者名稱。你的選擇已保留；請再試一次。',
      renameConsequence: ({ username }: { username: string }) =>
        `好友會透過新名稱找到你，使用 @${username} 的連結或徽章將失效。`,
      releaseTitle: '釋出使用者名稱',
      releaseDetail: ({ username }: { username: string }) =>
        `好友將無法再透過 @${username} 找到你，指向你公開頁面的連結也會失效。30 天內任何人都無法申請 @${username}，包括你自己。`,
      releaseAction: '釋出',
      releaseFailed: '無法釋出你的使用者名稱。未做任何變更。',
    },
    profile: {
      title: '公開檔案',
      entrySubtitle: '展示你的代理程式建置成果的頁面',
      searchKeywords: '公開檔案, 公開頁面, 徽章, README, 分享, 使用者代號, 使用者名稱, 發布',
      purposeIntro: '在你選定的連結上，展示你的代理程式建置成果的頁面。',
      purposePublished: ({ url }: { url: string }) => `其他人會在 ${url} 這樣查看你的代理程式使用情況。`,
      openPage: '開啟頁面',
      invitationTitle: '展示你的代理程式建置了什麼',
      invitationBody:
        '彙總數據、活動日曆和你的代理程式，都在一個可從 README 連結的頁面上。發布之前不會公開任何內容，每個欄位都由你選擇。',
      usernameFirst: '你的頁面使用你的使用者名稱作為位址。請先選擇一個。',
      chooseUsername: '選擇使用者名稱',
      yourPage: '你的頁面',
      link: '連結',
      status: '狀態',
      statusPublished: ({ synced }: { synced: string }) => `已發布 · ${synced}已同步`,
      statusPaused: '已暫停 · 訪客會看到已暫停的頁面',
      syncNow: '立即同步',
      handle: '使用者代號',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · 也是你在好友中使用的使用者名稱`,
      change: '變更',
      whatsPublic: '公開內容',
      whatsPublicDescription:
        '你在頁面上逐項選擇。你分享的項目也會出現在徽章和公開 JSON 中。',
      period: '期間',
      periodDetail: ({ range }: { range: string }) =>
        `${range}。所有數字、日曆、徽章和卡片都涵蓋相同的天數。`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${total} 項中有 ${shown} 項公開`,
      teamUsage: '團隊用量',
      teamUsageDetail:
        '絕不包含。來自團隊席位或無法區分的席位的用量，不會出現在你的檔案中。',
      excluded: '已排除',
      searchEngines: '搜尋引擎',
      indexTitle: '允許搜尋引擎索引你的頁面',
      indexOff: '關閉：他人只能透過連結存取',
      indexOn: '開啟：搜尋引擎可能會收錄你的頁面',
      pauseOrRemove: '暫停或移除',
      pauseTitle: '暫停檔案',
      pauseDetail: '保留你的連結和使用者代號；恢復之前，訪客會看到已暫停的頁面',
      pause: '暫停',
      resumeTitle: '恢復檔案',
      resumeDetail: '根據相同的項目重新計算你的頁面並再次顯示',
      resume: '恢復',
      unpublishTitle: '取消發布',
      unpublishDetail:
        '刪除公開紀錄。你的頁面、徽章和預覽圖片會在下次被請求時失效；已發布到其他地方的圖片會維持原樣。',
      unpublishAction: '取消發布…',
      restrictedTitle: '你的頁面已被移除',
      restrictedBody: ({ reason }: { reason: string }) =>
        `此服務的營運者已移除你的頁面：「${reason}」。請聯絡營運者了解詳情。你的用量和使用者名稱維持不變。`,
      unavailableTitle: '此處不提供公開檔案',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} 不提供公開檔案。你的用量維持私密。`,
      loadFailedTitle: '無法載入你的公開檔案',
      loadFailedBody: '未做任何變更。請稍後再試。',
      retry: '重試',
      actionFailed: '操作未成功。未做任何變更。',
      actionUncertain: '服務沒有回應。下方的頁面是它目前顯示的內容。',
      savedRefreshPending: '已儲存。你頁面上的數字會在下次同步時更新。',
      reasons: {
        feature_disabled: '此服務已關閉公開檔案。',
        username_required: '請先選擇使用者名稱。',
        report_contact_unconfigured:
          '此服務尚未設定檢舉聯絡方式，因此無法發布頁面。請詢問其營運者。',
        public_ingress_unconfigured:
          '此服務尚未設定公開位址，因此無法發布頁面。請詢問其營運者。',
        not_published: '你的頁面尚未發布。',
        restricted: '此服務的營運者已移除你的頁面。',
        query_mismatch: '你的用量期間已變更。請開啟你的頁面並重新套用。',
        invalid_stored_content: '無法讀取你的公開頁面。請重新發布。',
        asset_unavailable: '你頁面的圖片不在此裝置上。請重新選擇。',
        usage_unavailable: '目前無法在此裝置上讀取你的用量。',
        usage_query_result_invalid: '你的用量回傳不完整。請重試。',
        project_visibility_unavailable: '無法確認某個專案是否公開。它不會出現在你的頁面上。',
        preparation_unavailable: '此裝置目前無法準備你的頁面。',
      },
    },
  },
};
