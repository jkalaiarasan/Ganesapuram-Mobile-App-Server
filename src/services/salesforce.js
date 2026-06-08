const axios = require('axios');

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;

let tokenCache = null;
let instanceUrlCache = null;
let tokenExpiry = null;

async function getAuth() {
  if (tokenCache && instanceUrlCache && tokenExpiry && Date.now() < tokenExpiry) {
    return { token: tokenCache, instanceUrl: instanceUrlCache };
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  let res;
  try {
    res = await axios.post(`${SF_LOGIN_URL}/services/oauth2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    const sfError = err.response?.data;
    console.error('SF Auth Error:', JSON.stringify(sfError || err.message));
    throw new Error(`Salesforce auth failed: ${sfError?.error} - ${sfError?.error_description}`);
  }

  tokenCache = res.data.access_token;
  instanceUrlCache = res.data.instance_url;
  tokenExpiry = Date.now() + 100 * 60 * 1000;
  console.log('SF connected:', instanceUrlCache);
  return { token: tokenCache, instanceUrl: instanceUrlCache };
}

async function sfQuery(soql) {
  const { token, instanceUrl } = await getAuth();
  let res = await axios.get(`${instanceUrl}/services/data/v63.0/query`, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${token}` },
  });
  let records = res.data.records;
  while (!res.data.done && res.data.nextRecordsUrl) {
    res = await axios.get(`${instanceUrl}${res.data.nextRecordsUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    records = records.concat(res.data.records);
  }
  return records;
}

async function queryMemberByEmail(email) {
  const rows = await sfQuery(
    `SELECT Id, Name, Email__c FROM Member__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' AND Is_Approved__c = true LIMIT 1`
  );
  return rows[0] || null;
}

// Bulk query — 4 queries total regardless of member count (no N+1)
async function getMemberListBulk() {
  const members = await sfQuery(
    `SELECT Id, Name, UPRId__c, Position__c, Department__c, Phone__c
     FROM Member__c WHERE Is_Approved__c = true AND HidePublic__c = false ORDER BY Order__c ASC NULLS LAST`
  );
  if (!members.length) return [];

  const memberIds = members.map(m => `'${m.Id}'`).join(',');
  const links = await sfQuery(
    `SELECT LinkedEntityId, ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN (${memberIds})`
  );

  const memberDocMap = {};
  links.forEach(link => {
    if (!memberDocMap[link.LinkedEntityId]) memberDocMap[link.LinkedEntityId] = link.ContentDocumentId;
  });

  const docIds = Object.values(memberDocMap);
  if (!docIds.length) return members.map(m => ({ ...m, contentVersionId: null }));

  const docIdStr = docIds.map(d => `'${d}'`).join(',');
  const versions = await sfQuery(
    `SELECT Id, ContentDocumentId FROM ContentVersion WHERE ContentDocumentId IN (${docIdStr}) ORDER BY CreatedDate DESC`
  );

  const docVersionMap = {};
  versions.forEach(v => {
    if (!docVersionMap[v.ContentDocumentId]) docVersionMap[v.ContentDocumentId] = v.Id;
  });

  return members.map(m => ({
    ...m,
    contentVersionId: memberDocMap[m.Id] ? (docVersionMap[memberDocMap[m.Id]] || null) : null,
  }));
}

async function getMemberByEmail(email) {
  const rows = await sfQuery(
    `SELECT Id, Name, Email__c, UPRId__c, Position__c, Department__c,
            DateOfBirth__c, Phone__c, Work__c, Location__c, Type__c
     FROM Member__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' AND Is_Approved__c = true LIMIT 1`
  );
  if (!rows[0]) return null;
  const m = rows[0];

  // Get profile image contentVersionId
  const links = await sfQuery(
    `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${m.Id}' LIMIT 1`
  );
  let contentVersionId = null;
  if (links.length) {
    const versions = await sfQuery(
      `SELECT Id FROM ContentVersion WHERE ContentDocumentId = '${links[0].ContentDocumentId}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    contentVersionId = versions[0]?.Id || null;
  }
  return { ...m, contentVersionId };
}

// Used by the image proxy route to stream the image
async function getImageStream(versionId) {
  const { token, instanceUrl } = await getAuth();
  const res = await axios.get(
    `${instanceUrl}/services/data/v63.0/sobjects/ContentVersion/${versionId}/VersionData`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'stream', timeout: 10000 }
  );
  return { stream: res.data, contentType: res.headers['content-type'] || 'image/jpeg' };
}

async function getMemberPushTokens() {
  const rows = await sfQuery(
    `SELECT Id, Name, ExpoPushToken__c FROM Member__c WHERE Is_Approved__c = true AND ExpoPushToken__c != null`
  );
  return rows.map(r => ({ id: r.Id, name: r.Name, token: r.ExpoPushToken__c }));
}

async function updateMemberPushToken(memberId, expoPushToken) {
  const { token, instanceUrl } = await getAuth();
  try {
    await axios.patch(
      `${instanceUrl}/services/data/v63.0/sobjects/Member__c/${memberId}`,
      { ExpoPushToken__c: expoPushToken },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[push-token] Saved for member ${memberId}`);
  } catch (err) {
    const sfErr = err.response?.data;
    const detail = JSON.stringify(sfErr ?? err.message);
    console.error('[push-token] SF error:', detail);
    // Attach SF detail so callers can surface it
    const rich = new Error(detail);
    rich.sfDetail = sfErr ?? err.message;
    rich.statusCode = err.response?.status;
    throw rich;
  }
}

async function verifyPushToken(memberId, expectedToken) {
  const safeId = String(memberId).replace(/[^a-zA-Z0-9]/g, '');
  const rows = await sfQuery(
    `SELECT ExpoPushToken__c FROM Member__c WHERE Id = '${safeId}' LIMIT 1`
  );
  return rows[0]?.ExpoPushToken__c === expectedToken;
}

async function updateSessionToken(memberId, sessionToken) {
  const { token, instanceUrl } = await getAuth();
  await axios.patch(
    `${instanceUrl}/services/data/v63.0/sobjects/Member__c/${memberId}`,
    { SessionToken__c: sessionToken },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

async function verifyMemberSession(memberId, sessionToken) {
  const safeId = String(memberId).replace(/[^a-zA-Z0-9]/g, '');
  const rows = await sfQuery(
    `SELECT SessionToken__c FROM Member__c WHERE Id = '${safeId}' LIMIT 1`
  );
  if (!rows[0]) return false;
  return rows[0].SessionToken__c === sessionToken;
}

async function createErrorLog(memberId, name, description) {
  const { token, instanceUrl } = await getAuth();
  const payload = {
    Name: String(name).slice(0, 80),
    Description__c: String(description).slice(0, 32000),
  };
  if (memberId) payload.Member__c = memberId;
  await axios.post(
    `${instanceUrl}/services/data/v63.0/sobjects/ErrorLog__c`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  console.log(`[errorLog] Created: ${name}`);
}

module.exports = {
  queryMemberByEmail,
  getMemberListBulk,
  getMemberByEmail,
  getImageStream,
  updateMemberPushToken,
  getMemberPushTokens,
  createErrorLog,
  updateSessionToken,
  verifyMemberSession,
  verifyPushToken,
};
