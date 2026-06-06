const axios = require('axios');

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;

let tokenCache = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (tokenCache && tokenExpiry && Date.now() < tokenExpiry) return tokenCache;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const res = await axios.post(`${SF_LOGIN_URL}/services/oauth2/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  tokenCache = res.data.access_token;
  tokenExpiry = Date.now() + 100 * 60 * 1000;
  return tokenCache;
}

async function sfQuery(soql) {
  const token = await getAccessToken();
  const res = await axios.get(`${SF_INSTANCE_URL}/services/data/v63.0/query`, {
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

async function getMemberList() {
  return sfQuery(
    `SELECT Id, Name, Username__c, UPRId__c, Position__c, Department__c
     FROM Member__c WHERE Is_Approved__c = true ORDER BY Order__c ASC NULLS LAST`
  );
}

async function getMemberByEmail(email) {
  const rows = await sfQuery(
    `SELECT Id, Name, Email__c, UPRId__c, Position__c, Department__c, Username__c
     FROM Member__c WHERE Email__c = '${email.replace(/'/g, "\\'")}' AND Is_Approved__c = true LIMIT 1`
  );
  return rows[0] || null;
}

async function getMemberProfileImageUrl(memberId) {
  try {
    const token = await getAccessToken();
    const links = await sfQuery(
      `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${memberId}' LIMIT 1`
    );
    if (!links.length) return null;

    const versions = await sfQuery(
      `SELECT Id FROM ContentVersion WHERE ContentDocumentId = '${links[0].ContentDocumentId}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (!versions.length) return null;

    return `${SF_INSTANCE_URL}/services/data/v63.0/sobjects/ContentVersion/${versions[0].Id}/VersionData?access_token=${token}`;
  } catch {
    return null;
  }
}

module.exports = {
  queryMemberByEmail,
  getMemberList,
  getMemberByEmail,
  getMemberProfileImageUrl,
};
