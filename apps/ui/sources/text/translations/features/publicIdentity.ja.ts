import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} は使えます`,
      taken: ({ username }: { username: string }) => `@${username} は使用されています`,
      reserved: ({ username }: { username: string }) => `@${username} はこのサービスで予約されています`,
      invalid: 'このサービスでは、そのユーザー名は使えません。',
      suggestions: '代わりに使えるもの',
      checkFailed: 'このユーザー名を確認できませんでした。選択は保持されています。もう一度お試しください。',
      renameConsequence: ({ username }: { username: string }) =>
        `友だちは新しい名前であなたを見つけます。@${username} を使ったリンクやバッジは動作しなくなります。`,
      releaseTitle: 'ユーザー名を手放す',
      releaseDetail: ({ username }: { username: string }) =>
        `友だちは @${username} であなたを見つけられなくなり、公開ページへのリンクも動作しなくなります。30 日間は、あなたを含め誰も @${username} を取得できません。`,
      releaseAction: '手放す',
      releaseFailed: 'ユーザー名を手放せませんでした。何も変更されていません。',
    },
    profile: {
      title: '公開プロフィール',
      entrySubtitle: 'エージェントが作ったものを見せるページ',
      searchKeywords: '公開プロフィール, 公開ページ, バッジ, README, 共有, ハンドル, ユーザー名, 公開',
      purposeIntro: 'エージェントが作ったものを、好きなリンクで見せるページです。',
      purposePublished: ({ url }: { url: string }) => `${url} で、他の人にエージェントの利用状況がこのように表示されます。`,
      openPage: 'ページを開く',
      invitationTitle: 'エージェントが作ったものを見せましょう',
      invitationBody:
        '合計、アクティビティカレンダー、エージェントを、README からリンクできるページにまとめます。公開するまで何も公開されず、各項目はあなたが選べます。',
      usernameFirst: 'ページはあなたのユーザー名の下に作られます。まず選んでください。',
      chooseUsername: 'ユーザー名を選ぶ',
      yourPage: 'あなたのページ',
      link: 'リンク',
      status: '状態',
      statusPublished: ({ synced }: { synced: string }) => `公開中 · ${synced} に同期`,
      statusPaused: '一時停止中 · 訪問者には一時停止中のページが表示されます',
      syncNow: '今すぐ同期',
      handle: 'ハンドル',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · 友だちで使うユーザー名でもあります`,
      change: '変更',
      whatsPublic: '公開される内容',
      whatsPublicDescription:
        '各項目はページ上で選べます。共有した項目は、バッジや公開 JSON にも表示されます。',
      period: '期間',
      periodDetail: ({ range }: { range: string }) =>
        `${range}。すべての数値、カレンダー、バッジ、カードは同じ日数を対象にします。`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${total} 件中 ${shown} 件を公開`,
      teamUsage: 'チームの利用状況',
      teamUsageDetail:
        '含まれることはありません。チームのシート、または区別できないシートでの利用は、プロフィールに載りません。',
      excluded: '除外',
      searchEngines: '検索エンジン',
      indexTitle: '検索エンジンにページのインデックスを許可',
      indexOff: 'オフ: リンクからのみアクセスできます',
      indexOn: 'オン: 検索エンジンがページを掲載することがあります',
      pauseOrRemove: '一時停止または削除',
      pauseTitle: 'プロフィールを一時停止',
      pauseDetail: 'リンクとハンドルは保持されます。再開するまで、訪問者には一時停止中のページが表示されます',
      pause: '一時停止',
      resumeTitle: 'プロフィールを再開',
      resumeDetail: '同じ項目からページを再計算して、もう一度表示します',
      resume: '再開',
      unpublishTitle: '公開を取り消す',
      unpublishDetail:
        '公開レコードを削除します。ページ、バッジ、プレビュー画像は次にリクエストされたときから動作しなくなります。すでに他の場所に投稿された画像はそのまま残ります。',
      unpublishAction: '公開を取り消す…',
      restrictedTitle: 'ページが削除されました',
      restrictedBody: ({ reason }: { reason: string }) =>
        `このサービスの運営者があなたのページを削除しました:「${reason}」。詳しくは運営者にお問い合わせください。利用状況とユーザー名は変わりません。`,
      unavailableTitle: 'ここでは公開プロフィールを利用できません',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} は公開プロフィールを提供していません。利用状況は非公開のままです。`,
      loadFailedTitle: '公開プロフィールを読み込めませんでした',
      loadFailedBody: '何も変更されていません。少し待ってからもう一度お試しください。',
      retry: 'もう一度試す',
      actionFailed: '完了しませんでした。何も変更されていません。',
      actionUncertain: 'サービスから応答がありませんでした。以下のページが現在表示されている内容です。',
      savedRefreshPending: '保存しました。ページの数値は次回の同期で更新されます。',
      reasons: {
        feature_disabled: 'このサービスでは公開プロフィールがオフになっています。',
        username_required: '先にユーザー名を選んでください。',
        report_contact_unconfigured:
          'このサービスには通報の連絡先がまだ設定されていないため、ページを公開できません。運営者にお問い合わせください。',
        public_ingress_unconfigured:
          'このサービスには公開アドレスがまだ設定されていないため、ページを公開できません。運営者にお問い合わせください。',
        not_published: 'ページは公開されていません。',
        restricted: 'このサービスの運営者があなたのページを削除しました。',
        query_mismatch: '利用状況の期間が変更されました。ページを開いて、もう一度適用してください。',
        invalid_stored_content: '公開ページを読み取れませんでした。もう一度公開してください。',
        asset_unavailable: 'ページの画像がこのデバイスにありません。もう一度選んでください。',
        usage_unavailable: '現在、このデバイスでは利用状況を読み取れません。',
        usage_query_result_invalid: '利用状況が不完全な状態で返されました。もう一度お試しください。',
        project_visibility_unavailable:
          'プロジェクトが公開であることを確認できませんでした。ページには載せません。',
        preparation_unavailable: '現在、このデバイスではページを準備できません。',
      },
    },
  },
};
