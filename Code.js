/**
 * 設定情報
 */
const CONFIG = {
  NOTION_API_KEY: PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY'),
  PAGE_OR_DB_ID: '7f0bc47e982b49a3a2edebeede8cfc4e',
  DIALY_FOLDER_ID: '1qU_5-VGImOPRVY0TiYiFqGUduH7LDTfk',
  LOGS_FOLDER_ID: '1243HCmn5mG1F7NHZZh-JXCahtZ3PsrKe',
  NOTION_VERSION: '2022-06-28'
};

/**
 * 翌朝（午前5時）に前日の日記・ライフログをNotionへ同期する関数
 */
function syncYesterdayDiaryToNotion() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const targetDateStr = Utilities.formatDate(yesterday, 'Asia/Tokyo', 'yyyy-MM-dd');
  syncDiaryByDate(targetDateStr);
}

/**
 * （手動実行・検証用）当日の日記・ライフログをNotionへ同期する関数
 */
function syncTodayDiaryToNotion() {
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  syncDiaryByDate(todayStr);
}

/**
 * 翌朝5:00〜6:00に前日分を自動同期するトリガーを登録・更新する関数
 * （実行すると古い同期トリガーを削除し、新しい朝5時トリガーを自動設定します）
 */
function setDailyMorningTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    const handler = trigger.getHandlerFunction();
    if (handler === 'syncYesterdayDiaryToNotion' || handler === 'syncTodayDiaryToNotion') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger('syncYesterdayDiaryToNotion')
    .timeBased()
    .atHour(5)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
  Logger.log('翌朝5時（5:00〜6:00）に前日分（syncYesterdayDiaryToNotion）を実行するトリガーを設定しました。');
}

function syncDiaryByDate(targetDateStr) {
  const folder = DriveApp.getFolderById(CONFIG.DIALY_FOLDER_ID);
  const fileName = `${targetDateStr}.md`;
  const files = folder.getFilesByName(fileName);

  if (!files.hasNext()) {
    Logger.log(`対象ファイルが見つかりません: ${fileName}`);
    return;
  }

  const file = files.next();
  let content = '';

  // Google ドキュメントから公式Markdown形式でエクスポート取得
  if (file.getMimeType() === MimeType.GOOGLE_DOCS) {
    const exportUrl = `https://docs.google.com/feeds/download/documents/export/Export?exportFormat=markdown&id=${file.getId()}`;
    const res = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true
    });
    content = res.getContentText('UTF-8');
  } else {
    content = file.getBlob().getDataAsString('UTF-8');
  }

  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const databaseId = resolveDatabaseId();
  if (!databaseId) {
    throw new Error('Notionデータベースを特定できませんでした。');
  }

  const schema = getDatabaseSchema(databaseId);
  const parsed = parseDiaryMarkdown(content, targetDateStr, schema);

  const existingPageId = findNotionPageByDate(databaseId, targetDateStr, schema.dateProp);
  let notionPageUrl = '';

  if (existingPageId) {
    // 既存ページの場合：プロパティ（今日の一言、カロリー等）を安全に更新
    updateNotionPageProperties(existingPageId, parsed.properties);
    // 既存ブロックは一切削除せず、末尾にブロックを追加
    appendNotionBlocks(existingPageId, parsed.blocks);
    notionPageUrl = `https://app.notion.com/${existingPageId.replace(/-/g, '')}`;
    Logger.log(`同期成功（プロパティ更新・ブロック追記）: ${notionPageUrl}`);
  } else {
    // 新規作成
    const newPage = createNotionPage(databaseId, parsed.properties, parsed.blocks);
    notionPageUrl = newPage.url;
    Logger.log(`同期成功（新規作成）: ${notionPageUrl}`);
  }

  saveSyncLog(targetDateStr, notionPageUrl, file.getUrl());
}

function resolveDatabaseId() {
  const dbUrl = `https://api.notion.com/v1/databases/${CONFIG.PAGE_OR_DB_ID}`;
  const dbRes = UrlFetchApp.fetch(dbUrl, {
    method: 'GET',
    headers: getNotionHeaders(),
    muteHttpExceptions: true
  });
  if (dbRes.getResponseCode() === 200) return CONFIG.PAGE_OR_DB_ID;

  const blockUrl = `https://api.notion.com/v1/blocks/${CONFIG.PAGE_OR_DB_ID}/children?page_size=100`;
  const blockRes = UrlFetchApp.fetch(blockUrl, {
    method: 'GET',
    headers: getNotionHeaders(),
    muteHttpExceptions: true
  });

  if (blockRes.getResponseCode() === 200) {
    const data = JSON.parse(blockRes.getContentText());
    for (const b of data.results) {
      if (b.type === 'child_database') return b.id;
    }
  }

  const searchUrl = 'https://api.notion.com/v1/search';
  const searchRes = UrlFetchApp.fetch(searchUrl, {
    method: 'POST',
    headers: getNotionHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify({ filter: { value: 'database', property: 'object' }, page_size: 10 }),
    muteHttpExceptions: true
  });

  if (searchRes.getResponseCode() === 200) {
    const sData = JSON.parse(searchRes.getContentText());
    if (sData.results && sData.results.length > 0) return sData.results[0].id;
  }
  return null;
}

function getDatabaseSchema(databaseId) {
  const url = `https://api.notion.com/v1/databases/${databaseId}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: getNotionHeaders(),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  const schema = { titleProp: 'ハイライト', dateProp: '日付', availableProps: [] };

  if (data.properties) {
    schema.availableProps = Object.keys(data.properties);
    for (const [name, prop] of Object.entries(data.properties)) {
      if (prop.type === 'title') schema.titleProp = name;
      if (prop.type === 'date') schema.dateProp = name;
    }
  } else {
    // 取得失敗時のフォールバック定義
    schema.availableProps = ['名前', 'ハイライト', '日付', '体重', '体脂肪率', 'カロリー', '塩分', '今日の一言'];
  }
  return schema;
}

/**
 * 過去1ヶ月分の全表記ブレ・構造ブレに対応する柔軟な日記パーサー
 */
function parseDiaryMarkdown(mdText, dateStr, schema) {
  // 1. 改行コードおよびDocsエクスポートHTMLタグの正規化
  let text = mdText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/<line-break\s*\/?>/gi, '\n');
  
  // 2. エスケープされたマークダウン記号（\_、\*、\-、\#、\| 等）のアンエスケープ
  text = text.replace(/\\([_*\\-#`~|])/g, '$1');
  text = text.replace(/^\uFEFF/, ''); // BOM除去

  // 3. ヘッダー / Front Matter 抽出（---, -----, または最初の見出し前の部分）
  let frontMatter = '';
  let body = text;

  const fmMatch = text.match(/^(?:[\s\n]*[-]{3,})[ \t]*\n([\s\S]*?)\n(?:[-]{3,})[ \t]*/);
  if (fmMatch) {
    frontMatter = fmMatch[1];
    body = text.substring(fmMatch[0].length).trim();
  } else {
    const headingMatch = text.match(/\n(?=#[^#])/);
    if (headingMatch) {
      frontMatter = text.substring(0, headingMatch.index).trim();
      body = text.substring(headingMatch.index).trim();
    }
  }

  // 4. 各種数値プロパティの抽出（Front Matter -> 本文測定データ表 -> 概要テキストの多段フォールバック）
  let weight = null;
  let bodyFat = null;
  let calories = null;
  let salt = null;

  // --- 体重 ---
  const wm = frontMatter.match(/(?:weight|体重)\s*[:：|]\s*([0-9.]+)/i);
  if (wm) weight = parseFloat(wm[1]);
  if (weight === null) {
    const m = text.match(/\|\s*体重\s*\|\s*(?:約\s*)?([0-9.]+)\s*(?:kg|キロ)?/i) || text.match(/体重[：:]\s*(?:約\s*)?([0-9.]+)\s*(?:kg|キロ)?/i);
    if (m) weight = parseFloat(m[1]);
  }

  // --- 体脂肪率 ---
  const bfm = frontMatter.match(/(?:body_fat|bodyfat|体脂肪率|体脂肪)\s*[:：|]\s*([0-9.]+)/i);
  if (bfm) bodyFat = parseFloat(bfm[1]);
  if (bodyFat === null) {
    const m = text.match(/\|\s*体脂肪率\s*\|\s*(?:約\s*)?([0-9.]+)\s*%/i) || text.match(/体脂肪率[：:]\s*(?:約\s*)?([0-9.]+)\s*%/i);
    if (m) bodyFat = parseFloat(m[1]);
  }

  // --- カロリー ---
  const cm = frontMatter.match(/(?:calories|calorie|cal|カロリー|総カロリー)\s*[:：|]\s*([0-9,]+)/i);
  if (cm) calories = parseInt(cm[1].replace(/,/g, ''), 10);
  if (calories === null) {
    const m = text.match(/\|\s*(?:カロリー合計|総カロリー|カロリー|摂取カロリー|エネルギー)\s*\|\s*(?:約\s*)?([0-9,]+)\s*(?:kcal)?/i) ||
              text.match(/(?:カロリー合計|総カロリー|総摂取カロリー|総摂取エネルギー)[^0-9\n]*約?\s*([0-9,]+)\s*kcal/i);
    if (m) calories = parseInt(m[1].replace(/,/g, ''), 10);
  }

  // --- 塩分 ---
  const sm = frontMatter.match(/(?:salt|塩分|食塩相当量)\s*[:：|]\s*([0-9.]+)/i);
  if (sm) salt = parseFloat(sm[1]);
  if (salt === null) {
    const m = text.match(/\|\s*(?:食塩相当量|塩分|食塩)\s*\|\s*(?:約\s*)?([0-9.]+)\s*g/i) ||
              text.match(/(?:食塩相当量|塩分)[^0-9\n]*約?\s*([0-9.]+)\s*g/i);
    if (m) salt = parseFloat(m[1]);
  }

  // 5. 今日の一言（3行サマリー / 3行要約 / 今日のまとめ：見出しレベルや太字装飾を完全吸収）
  let comment = '';
  const summaryMatch = text.match(/(?:^|\n)#{1,4}\s*(?:\*\*)?(?:3行サマリー|3行要約|サマリー|今日のサマリー|本日のまとめ|まとめ)(?:\*\*)?([\s\S]*?)(?=\n#{1,4}\s*[^\n]+|\Z)/i);
  if (summaryMatch) {
    const lines = [];
    const rawLines = summaryMatch[1].split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      // 箇条書き（-, *, ・, +, 1., ①など）にマッチ
      if (/^(?:[-*・+]|[0-9]+[.)]|[①-⑩])\s*/.test(line)) {
        let clean = line.replace(/^(?:[-*・+]|[0-9]+[.)]|[①-⑩])\s*/, '');
        clean = clean.replace(/\[(.*?)\]\(.*?\)/g, '$1');
        clean = clean.replace(/\*\*(.*?)\*\*/g, '$1');
        if (clean) lines.push(clean);
      }
    }
    if (lines.length > 0) {
      comment = lines.join('\n');
    }
  }

  // 6. タイトル・日付設定
  const d = new Date(dateStr.replace(/-/g, '/'));
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const formattedTitle = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${days[d.getDay()]}）`;

  const properties = {};
  properties[schema.titleProp] = { title: [{ text: { content: formattedTitle } }] };
  properties[schema.dateProp] = { date: { start: dateStr } };

  // プロパティ存在確認と安全なセット
  const exists = (name) => schema.availableProps.length === 0 || schema.availableProps.includes(name);
  if (weight !== null && exists('体重')) properties['体重'] = { number: weight };
  if (bodyFat !== null && exists('体脂肪率')) properties['体脂肪率'] = { number: bodyFat };
  if (calories !== null && exists('カロリー')) properties['カロリー'] = { number: calories };
  if (salt !== null && exists('塩分')) properties['塩分'] = { number: salt };
  if (comment && exists('今日の一言')) properties['今日の一言'] = { rich_text: [{ text: { content: comment.slice(0, 1900) } }] };

  const blocks = convertMarkdownToBlocks(body);
  return { properties, blocks };
}

function parseRichText(text) {
  if (!text) return [];
  const richTexts = [];
  const regex = /(\*\*.*?\*\*|\[.*?\]\(.*?\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      richTexts.push({ type: 'text', text: { content: text.substring(lastIndex, match.index) } });
    }
    const matchedStr = match[0];
    if (matchedStr.startsWith('**') && matchedStr.endsWith('**')) {
      richTexts.push({
        type: 'text',
        text: { content: matchedStr.slice(2, -2) },
        annotations: { bold: true }
      });
    } else if (matchedStr.startsWith('[') && matchedStr.includes('](')) {
      const linkParts = matchedStr.match(/\[(.*?)\]\((.*?)\)/);
      if (linkParts) {
        richTexts.push({
          type: 'text',
          text: { content: linkParts[1], link: { url: linkParts[2] } }
        });
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    richTexts.push({ type: 'text', text: { content: text.substring(lastIndex) } });
  }

  return richTexts.length > 0 ? richTexts : [{ type: 'text', text: { content: text } }];
}

function convertMarkdownToBlocks(bodyText) {
  const lines = bodyText.split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length && blocks.length < 95; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^###\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: parseRichText(line.replace(/^###\s+/, '').replace(/^\*\*|\*\*$/g, '')) }
      });
    } else if (/^##\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: parseRichText(line.replace(/^##\s+/, '').replace(/^\*\*|\*\*$/g, '')) }
      });
    } else if (/^#\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: parseRichText(line.replace(/^#\s+/, '').replace(/^\*\*|\*\*$/g, '')) }
      });
    } else if (/^>\s*/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseRichText(line.replace(/^>\s*/, '')) }
      });
    } else if (/^(?:[-*・+]|[0-9]+[.)])\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(line.replace(/^(?:[-*・+]|[0-9]+[.)])\s+/, '')) }
      });
    } else if (!line.startsWith('|') && !line.startsWith('---') && !line.startsWith('-----')) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: parseRichText(line) }
      });
    }
  }

  return blocks;
}

function findNotionPageByDate(databaseId, dateStr, datePropName) {
  const url = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const payload = {
    filter: { property: datePropName, date: { equals: dateStr } }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: getNotionHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (data.results && data.results.length > 0) return data.results[0].id;
  return null;
}

function createNotionPage(databaseId, properties, blocks) {
  const url = 'https://api.notion.com/v1/pages';
  const payload = {
    parent: { database_id: databaseId },
    properties: properties,
    children: blocks
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: getNotionHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  });
  return JSON.parse(res.getContentText());
}

function updateNotionPageProperties(pageId, properties) {
  const cleanId = pageId.replace(/-/g, '');
  const res = UrlFetchApp.fetch(`https://api.notion.com/v1/pages/${cleanId}`, {
    method: 'PATCH',
    headers: getNotionHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify({ properties: properties }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log(`Notionプロパティ更新エラー (${res.getResponseCode()}): ${res.getContentText()}`);
  }
}

function appendNotionBlocks(pageId, blocks) {
  if (!blocks || blocks.length === 0) return;
  const cleanId = pageId.replace(/-/g, '');
  UrlFetchApp.fetch(`https://api.notion.com/v1/blocks/${cleanId}/children`, {
    method: 'PATCH',
    headers: getNotionHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify({ children: blocks })
  });
}

function getNotionHeaders() {
  return {
    'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`,
    'Notion-Version': CONFIG.NOTION_VERSION
  };
}

function saveSyncLog(dateStr, notionUrl, fileUrl) {
  const logsFolder = DriveApp.getFolderById(CONFIG.LOGS_FOLDER_ID);
  const logDateFormatted = dateStr.replace(/-/g, '');
  const logFileName = `NOTION-SYNC-${logDateFormatted}.md`;
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const content = `---
title: Notion同期ログ (${dateStr})
date: ${dateStr}
synced_at: ${nowStr}
status: success
notion_url: ${notionUrl}
---

# Notion同期ログ (${dateStr})

## 実行サマリー

| 項目 | 内容 |
| :-: | :-: |
| 同期対象日 | ${dateStr} |
| 実行日時 | ${nowStr} |
| ステータス | 成功 (success) |
| Notion ページ | [${dateStr}](${notionUrl}) |

## 処理詳細
- 日記データ確認: 完了 ([${dateStr}.md](${fileUrl}))
- Notion 接続・疎通確認: 完了 (REST API直接実行)
- プロパティ同期: 完了
- ページ本文挿入: 完了
`;

  const existingFiles = logsFolder.getFilesByName(logFileName);
  if (existingFiles.hasNext()) {
    existingFiles.next().setContent(content);
  } else {
    logsFolder.createFile(logFileName, content, MimeType.PLAIN_TEXT);
  }
}
