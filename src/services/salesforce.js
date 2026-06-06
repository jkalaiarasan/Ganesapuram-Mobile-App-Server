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
  const res = await axios.get(`${instanceUrl}/services/data/v63.0/query`, {
    params: { q: soql },
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data.records;
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
     FROM Member__c WHERE Is_Approved__c = true ORDER BY Order__c ASC NULLS LAST`
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
            DateOfBirth__c, Phone__c, Work__c, Location__c
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

module.exports = {
  queryMemberByEmail,
  getMemberListBulk,
  getMemberByEmail,
  getImageStream,
};
