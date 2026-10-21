import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} 可用`,
      taken: ({ username }: { username: string }) => `@${username} 已被占用`,
      reserved: ({ username }: { username: string }) => `@${username} 在此服务上为保留名称`,
      invalid: '此服务不允许使用该用户名。',
      suggestions: '可改用',
      checkFailed: '无法检查此用户名。你的选择已保留；请重试。',
      renameConsequence: ({ username }: { username: string }) =>
        `好友将通过新名称找到你，使用 @${username} 的链接或徽章将失效。`,
      releaseTitle: '释放用户名',
      releaseDetail: ({ username }: { username: string }) =>
        `好友将无法再通过 @${username} 找到你，指向你公开页面的链接也会失效。30 天内任何人都无法注册 @${username}，包括你自己。`,
      releaseAction: '释放',
      releaseFailed: '无法释放你的用户名。未做任何更改。',
    },
    profile: {
      title: '公开资料',
      entrySubtitle: '展示你的智能体构建成果的页面',
      searchKeywords: '公开资料, 公开页面, 徽章, README, 分享, 用户标识, 用户名, 发布',
      purposeIntro: '在你选定的链接上，展示你的智能体构建成果的页面。',
      purposePublished: ({ url }: { url: string }) => `其他人会在 ${url} 这样查看你的智能体使用情况。`,
      openPage: '打开页面',
      invitationTitle: '展示你的智能体构建了什么',
      invitationBody:
        '汇总数据、活动日历和你的智能体，都在一个可从 README 链接的页面上。发布之前不会公开任何内容，每个字段都由你选择。',
      usernameFirst: '你的页面使用你的用户名作为地址。请先选择一个。',
      chooseUsername: '选择用户名',
      yourPage: '你的页面',
      link: '链接',
      status: '状态',
      statusPublished: ({ synced }: { synced: string }) => `已发布 · ${synced}已同步`,
      statusPaused: '已暂停 · 访客会看到已暂停的页面',
      syncNow: '立即同步',
      handle: '用户标识',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · 也是你在好友中使用的用户名`,
      change: '更改',
      whatsPublic: '公开内容',
      whatsPublicDescription:
        '你在页面上逐项选择。你分享的项目也会出现在徽章和公开 JSON 中。',
      period: '时间范围',
      periodDetail: ({ range }: { range: string }) =>
        `${range}。所有数字、日历、徽章和卡片都覆盖相同的天数。`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${total} 项中有 ${shown} 项公开`,
      teamUsage: '团队用量',
      teamUsageDetail:
        '从不包含。来自团队席位或无法区分的席位的用量，不会出现在你的资料中。',
      excluded: '已排除',
      searchEngines: '搜索引擎',
      indexTitle: '允许搜索引擎索引你的页面',
      indexOff: '关闭：他人只能通过链接访问',
      indexOn: '开启：搜索引擎可能会收录你的页面',
      pauseOrRemove: '暂停或移除',
      pauseTitle: '暂停资料',
      pauseDetail: '保留你的链接和用户标识；恢复之前，访客会看到已暂停的页面',
      pause: '暂停',
      resumeTitle: '恢复资料',
      resumeDetail: '根据相同的项目重新计算你的页面并再次显示',
      resume: '恢复',
      unpublishTitle: '取消发布',
      unpublishDetail:
        '删除公开记录。你的页面、徽章和预览图片会在下次被请求时失效；已发布到其他地方的图片会保持原样。',
      unpublishAction: '取消发布…',
      restrictedTitle: '你的页面已被移除',
      restrictedBody: ({ reason }: { reason: string }) =>
        `此服务的运营者已移除你的页面：“${reason}”。请联系运营者了解详情。你的用量和用户名保持不变。`,
      unavailableTitle: '此处不提供公开资料',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} 不提供公开资料。你的用量保持私密。`,
      loadFailedTitle: '无法加载你的公开资料',
      loadFailedBody: '未做任何更改。请稍后再试。',
      retry: '重试',
      actionFailed: '操作未成功。未做任何更改。',
      actionUncertain: '服务没有响应。下方的页面是它目前显示的内容。',
      savedRefreshPending: '已保存。你页面上的数字会在下次同步时更新。',
      reasons: {
        feature_disabled: '此服务已关闭公开资料。',
        username_required: '请先选择用户名。',
        report_contact_unconfigured:
          '此服务尚未设置举报联系方式，因此无法发布页面。请询问其运营者。',
        public_ingress_unconfigured:
          '此服务尚未设置公开地址，因此无法发布页面。请询问其运营者。',
        not_published: '你的页面尚未发布。',
        restricted: '此服务的运营者已移除你的页面。',
        query_mismatch: '你的用量时间范围已更改。请打开你的页面并重新应用。',
        invalid_stored_content: '无法读取你的公开页面。请重新发布。',
        asset_unavailable: '你页面的图片不在此设备上。请重新选择。',
        usage_unavailable: '目前无法在此设备上读取你的用量。',
        usage_query_result_invalid: '你的用量返回不完整。请重试。',
        project_visibility_unavailable: '无法确认某个项目是否公开。它不会出现在你的页面上。',
        preparation_unavailable: '此设备目前无法准备你的页面。',
      },
    },
  },
};
