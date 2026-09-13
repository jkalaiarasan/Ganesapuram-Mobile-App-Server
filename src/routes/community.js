const express = require('express');
const router = express.Router();
const { sfQuery, soqlEscape, createTripMember } = require('../services/salesforce');

// Salesforce ids are alphanumeric only — anything else cannot be a real id, so
// reject rather than interpolate it into SOQL.
function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(id);
}

// Collapse an Event__c's ContentDocumentLinks into the newest ContentVersion id
// per document, which the existing /api/member/image/:versionId proxy can serve.
async function attachImages(records) {
  const docIds = [];
  const byRecord = {};

  for (const r of records) {
    const links = r.ContentDocumentLinks?.records ?? [];
    byRecord[r.Id] = links.map(l => l.ContentDocumentId);
    for (const l of links) docIds.push(l.ContentDocumentId);
  }

  if (!docIds.length) {
    return records.map(r => ({ ...r, imageIds: [] }));
  }

  const unique = [...new Set(docIds)].map(d => `'${d}'`).join(',');
  const versions = await sfQuery(
    `SELECT Id, ContentDocumentId FROM ContentVersion
     WHERE ContentDocumentId IN (${unique}) AND IsLatest = true`
  );

  const newest = {};
  for (const v of versions) {
    if (!newest[v.ContentDocumentId]) newest[v.ContentDocumentId] = v.Id;
  }

  return records.map(r => ({
    ...r,
    imageIds: (byRecord[r.Id] ?? []).map(d => newest[d]).filter(Boolean),
  }));
}

// GET /api/community/events?trip=true — trips only; otherwise everything else.
// Mirrors PaaraiBoysController.getEvents(isBlueMoon).
router.get('/events', async (req, res) => {
  const tripsOnly = req.query.trip === 'true';
  try {
    const raw = await sfQuery(
      `SELECT Id, Name, NameEnglish__c, Date__c, Type__c, Venue__c, Destination__c,
              DepartureTime__c, ReturnTime__c, TotalSeat__c, EventCode__c, Organizer__c,
              (SELECT ContentDocumentId FROM ContentDocumentLinks)
       FROM Event__c
       WHERE Type__c ${tripsOnly ? '=' : '!='} 'Trip'
       ORDER BY Date__c DESC`
    );
    const withImages = await attachImages(raw);

    res.json({
      success: true,
      events: withImages.map(e => ({
        id: e.Id,
        name: e.Name,
        nameEnglish: e.NameEnglish__c || null,
        date: e.Date__c || null,
        type: e.Type__c || null,
        venue: e.Venue__c || null,
        destination: e.Destination__c || null,
        departureTime: e.DepartureTime__c || null,
        returnTime: e.ReturnTime__c || null,
        totalSeats: e.TotalSeat__c ?? null,
        eventCode: e.EventCode__c || null,
        organizer: e.Organizer__c || null,
        imageIds: e.imageIds,
      })),
    });
  } catch (err) {
    console.error('events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
});

// GET /api/community/events/:id — roster, competitions and participants in one
// call, so an event detail screen does not need three round trips.
router.get('/events/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid event id' });

  try {
    const [tripMembers, competitions, participants] = await Promise.all([
      sfQuery(
        `SELECT Id, Name, Status__c, MobileNo__c, Email__c, SignedBy__c, SignedTime__c, CreatedDate
         FROM TripMember__c WHERE Event__c = '${id}' ORDER BY CreatedDate ASC`
      ),
      sfQuery(
        `SELECT Id, Name, (SELECT Id, Name__c, Prize__c FROM CompetitionMembers__r ORDER BY Prize__c ASC)
         FROM Competition__c WHERE Event__c = '${id}' ORDER BY CreatedDate ASC`
      ),
      sfQuery(
        `SELECT Id, Name, Type__c FROM EventMember__c WHERE Event__c = '${id}' ORDER BY CreatedDate ASC`
      ),
    ]);

    const counts = tripMembers.reduce((acc, m) => {
      const key = (m.Status__c || 'Pending Approval').toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      tripMembers: tripMembers.map(m => ({
        id: m.Id,
        name: m.Name,
        status: m.Status__c || 'Pending Approval',
        mobile: m.MobileNo__c || null,
        signedBy: m.SignedBy__c || null,
        signedTime: m.SignedTime__c || null,
      })),
      statusCounts: counts,
      competitions: competitions.map(c => ({
        id: c.Id,
        name: c.Name,
        winners: (c.CompetitionMembers__r?.records ?? []).map(w => ({
          id: w.Id,
          name: w.Name__c || null,
          prize: w.Prize__c || null,
        })),
      })),
      participants: participants.map(p => ({
        id: p.Id,
        name: p.Name,
        type: p.Type__c || null,
      })),
    });
  } catch (err) {
    console.error('event detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch event detail' });
  }
});

// GET /api/community/calendar — member birthdays plus org dates, for a month grid.
// Mirrors getMemberDOB + getCustomEvents.
router.get('/calendar', async (req, res) => {
  try {
    const [members, custom] = await Promise.all([
      sfQuery(
        `SELECT Id, Name, UPRId__c, DateOfBirth__c FROM Member__c
         WHERE Is_Approved__c = true AND DateOfBirth__c != null`
      ),
      sfQuery(`SELECT Id, Name, Message__c, Date__c FROM CustomEvent__c ORDER BY Date__c ASC`),
    ]);

    res.json({
      success: true,
      birthdays: members.map(m => ({
        id: m.Id,
        name: m.Name,
        uprId: m.UPRId__c || null,
        dob: m.DateOfBirth__c,
      })),
      occasions: custom.map(c => ({
        id: c.Id,
        name: c.Name,
        message: c.Message__c || null,
        date: c.Date__c || null,
      })),
    });
  } catch (err) {
    console.error('calendar error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch calendar' });
  }
});

// GET /api/community/birthdays/today — whoever is celebrating today, so the
// app can surface it without pulling the whole calendar.
router.get('/birthdays/today', async (req, res) => {
  try {
    const rows = await sfQuery(
      `SELECT Id, Name, UPRId__c, DateOfBirth__c, Position__c
       FROM Member__c
       WHERE Is_Approved__c = true AND HidePublic__c = false AND DateOfBirth__c != null`
    );

    // Compare month/day in the server's local date rather than filtering in
    // SOQL, so this matches what CALENDAR_MONTH/DAY_IN_MONTH pick in the batch.
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();

    const todays = rows.filter(r => {
      const [, mm, dd] = String(r.DateOfBirth__c).split('-');
      return parseInt(mm, 10) === m && parseInt(dd, 10) === d;
    });

    res.json({
      success: true,
      date: `${now.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      birthdays: todays.map(r => {
        const year = parseInt(String(r.DateOfBirth__c).split('-')[0], 10);
        return {
          id: r.Id,
          name: r.Name,
          uprId: r.UPRId__c || null,
          position: r.Position__c || null,
          turning: Number.isFinite(year) ? now.getFullYear() - year : null,
        };
      }),
    });
  } catch (err) {
    console.error('birthdays today error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch birthdays' });
  }
});

// GET /api/community/news — approved announcements only.
router.get('/news', async (req, res) => {
  try {
    const rows = await sfQuery(
      `SELECT Id, Title__c, Description__c, Created_Date__c, Member__r.Name
       FROM News__c WHERE Status__c = 'Approved' ORDER BY Created_Date__c DESC`
    );
    res.json({
      success: true,
      news: rows.map(n => ({
        id: n.Id,
        title: n.Title__c || null,
        description: n.Description__c || null,
        createdDate: n.Created_Date__c || null,
        author: n.Member__r?.Name || null,
      })),
    });
  } catch (err) {
    console.error('news error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch news' });
  }
});

// GET /api/community/trip — the single trip the Blue Moon page tracks, with its
// seat maths. The Apex pins this to one event by name; here the caller passes an
// id so the app is not tied to a hardcoded event.
router.get('/trip/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid event id' });

  try {
    const [events, members] = await Promise.all([
      sfQuery(
        `SELECT Id, Name, TotalSeat__c, Date__c, Destination__c, DepartureTime__c, ReturnTime__c
         FROM Event__c WHERE Id = '${id}' LIMIT 1`
      ),
      sfQuery(`SELECT Id, Status__c FROM TripMember__c WHERE Event__c = '${id}'`),
    ]);

    if (!events.length) return res.status(404).json({ success: false, message: 'Event not found' });
    const e = events[0];

    const accepted = members.filter(m => m.Status__c === 'Accepted').length;
    const rejected = members.filter(m => m.Status__c === 'Rejected').length;

    res.json({
      success: true,
      trip: {
        id: e.Id,
        name: e.Name,
        date: e.Date__c || null,
        destination: e.Destination__c || null,
        departureTime: e.DepartureTime__c || null,
        returnTime: e.ReturnTime__c || null,
        totalSeats: e.TotalSeat__c ?? null,
        registrations: members.length,
        accepted,
        rejected,
        seatsLeft: e.TotalSeat__c != null ? Math.max(e.TotalSeat__c - accepted, 0) : null,
      },
    });
  } catch (err) {
    console.error('trip error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch trip' });
  }
});

// POST /api/community/trip/:id/register — request a seat. Mirrors
// TripTicketController.createTripMember.
router.post('/trip/:id/register', async (req, res) => {
  const { id } = req.params;
  const { name, mobile, email } = req.body;

  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid event id' });
  if (!name || !mobile) {
    return res.status(400).json({ success: false, message: 'name and mobile are required' });
  }

  try {
    const existing = await sfQuery(
      `SELECT Id FROM TripMember__c
       WHERE Event__c = '${id}' AND MobileNo__c = '${soqlEscape(mobile)}' LIMIT 1`
    );
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'This mobile number is already registered' });
    }

    const created = await createTripMember(id, { name, mobile, email });
    res.json({ success: true, id: created });
  } catch (err) {
    console.error('trip register error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to register' });
  }
});

module.exports = router;
