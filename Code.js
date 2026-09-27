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

function syncTodayDiaryToNotion() {
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  syncDiaryByDate(todayStr);
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
  const schema = { titleProp: '名前', dateProp: '日付', availableProps: [] };

  if (data.properties) {
    schema.availableProps = Object.keys(data.properties);
    for (const [name, prop] of Object.entries(data.properties)) {
      if (prop.type === 'title') schema.titleProp = name;
      if (prop.type === 'date') schema.dateProp = name;
    }
  }
  return schema;
}

function parseDiaryMarkdown(mdText, dateStr, schema) {
  mdText = mdText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. Front Matterの柔軟な抽出（---、\---、BOM、または見出し前のキーバリュー群に対応）
  let frontMatter = '';
  let body = mdText;

  const fmMatch = mdText.match(/^(?:\\?---|﻿\\?---)[ \t]*\n([\s\S]*?)\n(?:\\?---)[ \t]*/);
  if (fmMatch) {
    frontMatter = fmMatch[1];
    body = mdText.substring(fmMatch[0].length).trim();
  } else {
    const headingMatch = mdText.match(/\n(?=#[^#])/);
    if (headingMatch) {
      frontMatter = mdText.substring(0, headingMatch.index).trim();
      body = mdText.substring(headingMatch.index).trim();
    }
  }

  // アンダースコアのエスケープ（\_ -> _）を正規化
  const normalizedFm = frontMatter.replace(/\\_/g, '_');

  // 数値プロパティの抽出
  let weight = null;
  let bodyFat = null;
  let calories = null;
  let salt = null;

  const weightMatch = normalizedFm.match(/weight:\s*([0-9.]+)/);
  if (weightMatch) weight = parseFloat(weightMatch[1]);

  const bodyFatMatch = normalizedFm.match(/body_fat:\s*([0-9.]+)/);
  if (bodyFatMatch) bodyFat = parseFloat(bodyFatMatch[1]);

  const caloriesMatch = normalizedFm.match(/calories:\s*([0-9]+)/);
  if (caloriesMatch) calories = parseInt(caloriesMatch[1], 10);

  const saltMatch = normalizedFm.match(/salt:\s*([0-9.]+)/);
  if (saltMatch) salt = parseFloat(saltMatch[1]);

  // Front Matterに数値がない場合は本文の測定データ表からフォールバック抽出
  if (weight === null) {
    const m = mdText.match(/\|\s*体重\s*\|\s*(?:約\s*)?([0-9.]+)\s*kg/);
    if (m) weight = parseFloat(m[1]);
  }
  if (bodyFat === null) {
    const m = mdText.match(/\|\s*体脂肪率\s*\|\s*(?:約\s*)?([0-9.]+)\s*%/);
    if (m) bodyFat = parseFloat(m[1]);
  }
  if (calories === null) {
    const m = mdText.match(/\|\s*カロリー合計\s*\|\s*(?:約\s*)?([0-9,]+)\s*kcal/);
    if (m) calories = parseInt(m[1].replace(/,/g, ''), 10);
  }
  if (salt === null) {
    const m = mdText.match(/\|\s*食塩相当量\s*\|\s*(?:約\s*)?([0-9.]+)\s*g/);
    if (m) salt = parseFloat(m[1]);
  }

  // 2. 今日の一言（3行サマリー：H1〜H3、**太字**装飾付きに対応）
  let comment = '';
  const summaryBlockMatch = body.match(/#{1,3}\s*\**3行サマリー\**([\s\S]*?)(?=\n#{1,3}\s*|$)/i);
  if (summaryBlockMatch) {
    const lines = summaryBlockMatch[1].split('\n')
      .map(l => l.trim())
      .filter(l => /^[-*・]/.test(l))
      .map(l => l.replace(/^[-*・]\s*/, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1'));
    if (lines.length > 0) {
      comment = lines.join('\n');
    }
  }

  // 3. タイトル・日付設定
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

    if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: parseRichText(line.replace(/^###\s*/, '')) }
      });
    } else if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: parseRichText(line.replace(/^##\s*/, '')) }
      });
    } else if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: parseRichText(line.replace(/^#\s*/, '')) }
      });
    } else if (line.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseRichText(line.replace(/^>\s*/, '')) }
      });
    } else if (/^[-*・]\s+/.test(line)) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(line.replace(/^[-*・]\s+/, '')) }
      });
    } else if (!line.startsWith('|') && !line.startsWith('---')) {
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
  const content = `---\ntitle: Notion同期ログ (${dateStr})\ndate: ${dateStr}\nsynced_at: ${nowStr}\nstatus: success\nnotion_url: ${notionUrl}\n---\n\n# Notion同期ログ (${dateStr})\n\n## 実行サマリー\n\n| 項目 | 内容 |\n| :-: | :-: |\n| 同期対象日 | ${dateStr} |\n| 実行日時 | ${nowStr} |\n| ステータス | 成功 (success) |\n| Notion ページ | [${dateStr}](${notionUrl}) |\n\n## 処理詳細\n- 日記データ確認: 完了 ([${dateStr}.md](${fileUrl}))\n- Notion 接続・疎通確認: 完了 (REST API直接実行)\n- プロパティ同期: 完了\n- ページ本文挿入: 完了\n`;

  const existingFiles = logsFolder.getFilesByName(logFileName);
  if (existingFiles.hasNext()) {
    existingFiles.next().setContent(content);
  } else {
    logsFolder.createFile(logFileName, content, MimeType.PLAIN_TEXT);
  }
}
