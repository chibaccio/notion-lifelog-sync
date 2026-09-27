# notion-lifelog-sync (notionライフログ同期)

Google Drive 上の日記・ライフログ Markdown ファイルを解析し、Notion の「ライフログデータベース」へ自動同期する Google Apps Script (GAS) プロジェクトです。

## 構成ファイル
- `appsscript.json`: GAS マニフェスト設定
- `Code.js`: Notion同期メインロジック (Markdown解析、Notion API連携、同期ログ生成)
- `.clasp.json`: clasp 連携用設定 (Script ID 管理)

## 主な機能
1. Google Drive の日記フォルダ (`Dialy/`) から対象日付の Markdown を取得
2. Front Matter および測定データ表から体重・体脂肪率・カロリー・塩分を抽出
3. 3行サマリーから「今日の一言」を抽出
4. Notion REST API 経由で既存ページのプロパティ更新・本文挿入、または新規ページ作成
5. 同期結果を Google Drive の `Logs/` フォルダへ `NOTION-SYNC-YYYYMMDD.md` として記録
