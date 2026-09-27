/**
 * iPhone写真自動連携 Webhook
 * 
 * 役割:
 * iPhoneショートカットからPOSTされた昨日の写真データ（Base64）を受信し、
 * Notion File Upload API を使用してアップロードの上、
 * 対象日の日記ページの本文末尾へ画像ブロックとして追加します。
 * （※プロパティ「本日の一枚」には触れず、本文内へ追加します）
 */

const PHOTO_SYNC_CONFIG = {
  DATABASE_ID: '7f0bc47e982b49a3a2edebeede8cfc4e',
  DATE_PROP: 'Date',
  NOTION_VERSION: '2026-03-11',
  MAX_IMAGES: 15
};

function getNotionApiKeyForPhotos() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('NOTION_API_KEY') || props.getProperty('NOTION_TOKEN');
}

/**
 * iPhoneショートカットからのPOSTリクエスト受付口
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return makePhotoJsonResponse({ status: 'error', message: 'No payload provided' }, 400);
    }

    const payload = JSON.parse(e.postData.contents);

    // 1. セキュリティ検証：APIキーの照合
    const expectedKey = PropertiesService.getScriptProperties().getProperty('AUTH_SECRET_KEY');
    if (!expectedKey || payload.apiKey !== expectedKey) {
      console.warn('認証失敗: APIキーが不一致または未設定です。');
      return makePhotoJsonResponse({ status: 'forbidden', message: 'Invalid or missing API key' }, 403);
    }

    // 2. パラメータ確認
    const targetDate = payload.date; // 'YYYY-MM-DD'
    const images = payload.images || [];

    if (!targetDate) {
      return makePhotoJsonResponse({ status: 'error', message: 'Target date is missing' }, 400);
    }

    if (images.length === 0) {
      return makePhotoJsonResponse({ status: 'success', message: 'No images to process', uploaded: 0 });
    }

    if (images.length > PHOTO_SYNC_CONFIG.MAX_IMAGES) {
      return makePhotoJsonResponse({ status: 'error', message: `Too many images. Max allowed is ${PHOTO_SYNC_CONFIG.MAX_IMAGES}` }, 400);
    }

    // 3. Notionの日記ページIDを検索（Dateプロパティで特定）
    const pageId = findDiaryPageForPhotos(targetDate);
    if (!pageId) {
      console.warn(`対象日 (${targetDate}) の日記ページがNotionに見つかりませんでした。`);
      return makePhotoJsonResponse({ 
        status: 'skipped', 
        message: `Diary page for ${targetDate} not found in Notion database` 
      }, 404);
    }

    // 4. 画像を1枚ずつNotionへアップロードし、ページ本文末尾へ追加
    let successCount = 0;
    const errors = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const decodedBytes = Utilities.base64Decode(img.base64);
        const fileName = img.filename || `photo_${i + 1}.jpg`;
        const mimeType = img.mimeType || 'image/jpeg';
        const blob = Utilities.newBlob(decodedBytes, mimeType, fileName);

        // Notion File Upload API
        const fileUploadId = uploadImageBlobToNotion(blob);

        // 日記ページの本文末尾に画像ブロックを追加
        appendPhotoBlockToPage(pageId, fileUploadId);

        successCount++;
        Utilities.sleep(300); // Notion API レートリミット保護
      } catch (err) {
        console.error(`画像 [${img.filename}] の処理失敗: ${err.message}`);
        errors.push({ filename: img.filename, error: err.message });
      }
    }

    return makePhotoJsonResponse({
      status: 'success',
      targetDate: targetDate,
      totalReceived: images.length,
      uploaded: successCount,
      errors: errors
    });

  } catch (error) {
    console.error(`Webhook全体エラー: ${error.message}`);
    return makePhotoJsonResponse({ status: 'error', message: error.message }, 500);
  }
}

/**
 * 対象日付の日記ページを特定
 */
function findDiaryPageForPhotos(dateStr) {
  const token = getNotionApiKeyForPhotos();
  const url = `https://api.notion.com/v1/databases/${PHOTO_SYNC_CONFIG.DATABASE_ID}/query`;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': PHOTO_SYNC_CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      filter: {
        property: PHOTO_SYNC_CONFIG.DATE_PROP,
        date: { equals: dateStr }
      }
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Notion DBクエリ失敗 (${response.getResponseCode()}): ${response.getContentText()}`);
  }

  const data = JSON.parse(response.getContentText());
  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }
  return null;
}

/**
 * Notion File Upload API (Direct Upload)
 */
function uploadImageBlobToNotion(blob) {
  const token = getNotionApiKeyForPhotos();

  // Step 1: File Upload オブジェクト作成
  const createUrl = 'https://api.notion.com/v1/file_uploads';
  const createRes = UrlFetchApp.fetch(createUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': PHOTO_SYNC_CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      filename: blob.getName(),
      content_type: blob.getContentType()
    }),
    muteHttpExceptions: true
  });

  if (createRes.getResponseCode() !== 200) {
    throw new Error(`Notion File Upload作成失敗 (${createRes.getResponseCode()}): ${createRes.getContentText()}`);
  }

  const uploadObj = JSON.parse(createRes.getContentText());
  const fileUploadId = uploadObj.id;
  const sendUrl = uploadObj.upload_url || `https://api.notion.com/v1/file_uploads/${fileUploadId}/send`;

  // Step 2: バイナリを送信 (multipart/form-data)
  const sendRes = UrlFetchApp.fetch(sendUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': PHOTO_SYNC_CONFIG.NOTION_VERSION
    },
    payload: {
      file: blob
    },
    muteHttpExceptions: true
  });

  if (sendRes.getResponseCode() !== 200) {
    throw new Error(`Notion バイナリ送信失敗 (${sendRes.getResponseCode()}): ${sendRes.getContentText()}`);
  }

  return fileUploadId;
}

/**
 * 日記ページの本文末尾に画像ブロックを追加
 */
function appendPhotoBlockToPage(pageId, fileUploadId) {
  const token = getNotionApiKeyForPhotos();
  const cleanId = pageId.replace(/-/g, '');
  const url = `https://api.notion.com/v1/blocks/${cleanId}/children`;

  const payload = {
    children: [
      {
        object: 'block',
        type: 'image',
        image: {
          type: 'file_upload',
          file_upload: {
            id: fileUploadId
          }
        }
      }
    ]
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'patch',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': PHOTO_SYNC_CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Notion画像ブロック追加失敗 (${res.getResponseCode()}): ${res.getContentText()}`);
  }
}

/**
 * JSONレスポンス生成ヘルパー
 */
function makePhotoJsonResponse(data, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
