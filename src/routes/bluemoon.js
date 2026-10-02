const express = require('express');
const router = express.Router();
const {
  sfQuery, soqlEscape, sfCreateRecord, sfUpdateRecord, sfDeleteRecord, sfApexRest,
} = require('../services/salesforce');

// Blue Moon trips: pricing, booking, payments, and the admin desk — everything
// an admin needs without a Salesforce login.
//
// Visibility rule, enforced here rather than in the app:
//   - everyone sees an active trip's roster (name + status),
//   - booking details, invoices and receipts go only to a Blue Moon admin, or
//     to the signed-in member's household: the bookings they travel on or
//     registered, and any booking made with an email or phone they share
//     (brothers often share one email/phone).
// Travellers who are not members get their invoice and receipts by email only.

const SITE_URL = 'https://kalaiarasan-dev-ed.develop.my.site.com/upr/apex';
const STATUS = {
  PENDING: 'Pending Acceptance', ACCEPTED: 'Accepted', REJECTED: 'Rejected', CANCELLED: 'Cancelled',
};
const INVOICE = { DRAFT: 'Draft', ISSUED: 'Issued', CANCELLED: 'Cancelled' };
const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque'];
const GENDERS = ['Male', 'Female'];

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(id);
}

// 15- and 18-char ids name the same record; compare on the 15-char prefix.
function sameId(a, b) {
  return !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
}

const money = v => (typeof v === 'number' ? v : 0);
const quote = ids => ids.map(id => `'${id}'`).join(',');

function ageFrom(dob) {
  if (!dob) return null;
  const [y, m, d] = String(dob).split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age > 0 && age < 121 ? age : null;
}

// The app sends trip times as IST wall-clock 'YYYY-MM-DDTHH:MM'.
function istToIso(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(value).trim());
  if (!m) return undefined;
  return new Date(`${m[1]}T${m[2]}:00+05:30`).toISOString();
}

// Salesforce errors carry a readable message (validation rules, Apex
// exceptions); pass it through instead of a generic failure.
function sfErrorMessage(err, fallback) {
  const first = Array.isArray(err.response?.data) ? err.response.data[0] : null;
  if (!first?.message) return fallback;
  return first.message.replace(/^[\w.]+Exception: /, '');
}

// ── Who is calling ──────────────────────────────────────────────────────────

// Identifies the caller from the app's session headers. Returns null for a
// guest or a stale session — never throws for a bad token.
async function resolveViewer(req) {
  const memberId = req.headers['x-member-id'];
  const sessionToken = req.headers['x-session-token'];
  if (!validId(memberId) || !sessionToken) return null;

  const rows = await sfQuery(
    `SELECT Id, Name, Email__c, Phone__c, DateOfBirth__c, SessionToken__c, IsBlueMoonAdmin__c
     FROM Member__c WHERE Id = '${memberId}' AND Is_Approved__c = true LIMIT 1`
  );
  const m = rows[0];
  if (!m || m.SessionToken__c !== sessionToken) return null;

  // Household: members who share this member's email or phone.
  const conds = [];
  if (m.Email__c) conds.push(`Email__c = '${soqlEscape(m.Email__c)}'`);
  if (m.Phone__c) conds.push(`Phone__c = '${soqlEscape(m.Phone__c)}'`);
  const family = conds.length
    ? await sfQuery(`SELECT Id FROM Member__c WHERE ${conds.join(' OR ')}`)
    : [];
  const householdIds = [...new Set([m.Id, ...family.map(f => f.Id)])];

  return {
    id: m.Id,
    name: m.Name,
    email: m.Email__c || null,
    phone: m.Phone__c || null,
    dob: m.DateOfBirth__c || null,
    isAdmin: m.IsBlueMoonAdmin__c === true,
    householdIds,
  };
}

async function requireViewer(req, res, { admin = false } = {}) {
  const viewer = await resolveViewer(req);
  if (!viewer) {
    res.status(401).json({ success: false, message: 'Please sign in again' });
    return null;
  }
  if (admin && !viewer.isAdmin) {
    res.status(403).json({ success: false, message: 'Blue Moon admins only' });
    return null;
  }
  return viewer;
}

// Does this booking belong to the viewer's household?
function isMine(viewer, tm) {
  if (!viewer) return false;
  const inHouse = id => viewer.householdIds.some(h => sameId(h, id));
  return inHouse(tm.Member__c) || inHouse(tm.RegisteredBy__c)
    || (!!viewer.email && !!tm.Email__c && tm.Email__c.toLowerCase() === viewer.email.toLowerCase())
    || (!!viewer.phone && !!tm.MobileNo__c && tm.MobileNo__c === viewer.phone);
}

function householdWhere(viewer) {
  const ids = quote(viewer.householdIds);
  const conds = [`Member__c IN (${ids})`, `RegisteredBy__c IN (${ids})`];
  if (viewer.email) conds.push(`Email__c = '${soqlEscape(viewer.email)}'`);
  if (viewer.phone) conds.push(`MobileNo__c = '${soqlEscape(viewer.phone)}'`);
  return `(${conds.join(' OR ')})`;
}

// ── Shaping ─────────────────────────────────────────────────────────────────

function shapeLine(l) {
  return {
    id: l.Id,
    name: l.Name,
    description: l.Description__c || null,
    price: money(l.Price__c),
    quantity: l.Quantity__c ?? 1,
    gstApplicable: l.IsGSTApplicable__c === true,
    gstPercent: l.GSTPercent__c ?? 0,
    gstAmount: money(l.GSTAmount__c),
    total: money(l.TotalAmount__c),
    order: l.Order__c ?? null,
  };
}

// Open (non-cancelled) invoice with receipts for each booking, keyed by the
// booking's 15-char id.
async function billingFor(tripMemberIds) {
  if (!tripMemberIds.length) return {};
  const invoices = await sfQuery(
    `SELECT Id, Name, TripMember__c, Status__c, InvoiceDate__c, SubTotal__c, GSTAmount__c, TotalAmount__c,
            AmountPaid__c, BalanceDue__c, PaymentStatus__c, IsSent__c,
            (SELECT Id, Name, Amount__c, PaymentDate__c, PaymentMode__c, ReferenceNo__c, Notes__c, IsSent__c,
                    ReceivedBy__r.Name, CreatedDate
             FROM Receipts__r ORDER BY CreatedDate ASC)
     FROM Invoice__c
     WHERE TripMember__c IN (${quote(tripMemberIds)}) AND Status__c != '${INVOICE.CANCELLED}'`
  );
  const out = {};
  for (const inv of invoices) {
    const issued = inv.Status__c === INVOICE.ISSUED;
    out[inv.TripMember__c.slice(0, 15)] = {
      invoiceId: inv.Id,
      // A draft only holds an advance; it has no number the traveller knows.
      invoiceNumber: issued ? inv.Name : null,
      status: inv.Status__c,
      invoiceDate: inv.InvoiceDate__c || null,
      subTotal: money(inv.SubTotal__c),
      gstAmount: money(inv.GSTAmount__c),
      total: money(inv.TotalAmount__c),
      paid: money(inv.AmountPaid__c),
      balance: money(inv.BalanceDue__c),
      paymentStatus: inv.PaymentStatus__c || 'Unpaid',
      emailed: inv.IsSent__c === true,
      invoiceUrl: issued ? `${SITE_URL}/tripInvoice?id=${inv.Id}` : null,
      receipts: (inv.Receipts__r?.records ?? []).map(r => ({
        id: r.Id,
        number: r.Name,
        amount: money(r.Amount__c),
        date: r.PaymentDate__c || r.CreatedDate?.slice(0, 10) || null,
        mode: r.PaymentMode__c || null,
        reference: r.ReferenceNo__c || null,
        notes: r.Notes__c || null,
        receivedBy: r.ReceivedBy__r?.Name || null,
        emailed: r.IsSent__c === true,
        url: `${SITE_URL}/tripReceipt?id=${r.Id}`,
      })),
    };
  }
  return out;
}

const TRIP_FIELDS = `Id, Name, NameEnglish__c, Date__c, Destination__c, Venue__c, DepartureTime__c, ReturnTime__c,
  TotalSeat__c, EventCode__c, Organizer__c, Type__c, SubTotal__c, GSTAmount__c, TotalAmount__c,
  IsActiveTrip__c, PriceTemplate__c, PriceTemplate__r.Name`;

async function loadTrip(id) {
  const rows = await sfQuery(
    `SELECT ${TRIP_FIELDS},
            (SELECT Id, Name, Description__c, Price__c, Quantity__c, IsGSTApplicable__c, GSTPercent__c,
                    GSTAmount__c, TotalAmount__c, Order__c
             FROM LineItems__r ORDER BY Order__c ASC NULLS LAST, Name)
     FROM Event__c WHERE Id = '${id}' LIMIT 1`
  );
  return rows[0] || null;
}

// Registration is open only while Event__c.IsActiveTrip__c is ticked — the same
// switch the site's Blue Moon page uses — and the trip date has not passed.
function isClosed(trip) {
  if (!trip.IsActiveTrip__c) return true;
  if (!trip.Date__c) return false;
  const today = new Date().toISOString().slice(0, 10);
  return trip.Date__c < today;
}

function shapeTrip(t) {
  return {
    id: t.Id,
    name: t.Name,
    nameEnglish: t.NameEnglish__c || null,
    date: t.Date__c || null,
    destination: t.Destination__c || null,
    venue: t.Venue__c || null,
    departureTime: t.DepartureTime__c || null,
    returnTime: t.ReturnTime__c || null,
    eventCode: t.EventCode__c || null,
    organizer: t.Organizer__c || null,
    totalSeats: t.TotalSeat__c ?? null,
    isActive: t.IsActiveTrip__c === true,
    priceTemplate: t.PriceTemplate__c ? { id: t.PriceTemplate__c, name: t.PriceTemplate__r?.Name || null } : null,
  };
}

// ── Public / member routes ──────────────────────────────────────────────────

// GET /api/bluemoon/trips — the trips currently open on Blue Moon
// (IsActiveTrip__c), soonest first.
router.get('/trips', async (req, res) => {
  try {
    const rows = await sfQuery(
      `SELECT Id, Name, NameEnglish__c, Date__c, Destination__c
       FROM Event__c
       WHERE Type__c = 'Trip' AND IsActiveTrip__c = true
       ORDER BY Date__c ASC NULLS LAST`
    );
    res.json({
      success: true,
      trips: rows.map(t => ({
        id: t.Id,
        name: t.Name,
        nameEnglish: t.NameEnglish__c || null,
        date: t.Date__c || null,
        destination: t.Destination__c || null,
      })),
    });
  } catch (err) {
    console.error('bluemoon trips error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch trips' });
  }
});

// GET /api/bluemoon/trips/:id — full trip detail. The roster is public; each
// entry carries contact details and billing only when the caller may see them.
router.get('/trips/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid trip id' });

  try {
    const [trip, members, viewer] = await Promise.all([
      loadTrip(id),
      sfQuery(
        `SELECT Id, Name, Status__c, MobileNo__c, Email__c, Age__c, Gender__c, EmergencyContact__c, Source__c,
                Member__c, RegisteredBy__c, RegisteredBy__r.Name, ApprovedBy__r.Name, SignedTime__c, CreatedDate
         FROM TripMember__c WHERE Event__c = '${id}' ORDER BY CreatedDate ASC`
      ),
      resolveViewer(req),
    ]);
    if (!trip || trip.Type__c !== 'Trip') return res.status(404).json({ success: false, message: 'Trip not found' });

    const visible = members.filter(m => viewer?.isAdmin || isMine(viewer, m));
    const billing = await billingFor(visible.map(m => m.Id));

    const count = s => members.filter(m => (m.Status__c || STATUS.PENDING) === s).length;
    const accepted = count(STATUS.ACCEPTED);

    const roster = members.map(m => {
      const mine = isMine(viewer, m);
      const entry = {
        id: m.Id,
        name: m.Name,
        status: m.Status__c || STATUS.PENDING,
        isMine: mine,
        isSelf: !!viewer && sameId(m.Member__c, viewer.id),
        isMember: !!m.Member__c,
      };
      if (!viewer?.isAdmin && !mine) return entry;
      return {
        ...entry,
        mobile: m.MobileNo__c || null,
        email: m.Email__c || null,
        age: m.Age__c ?? null,
        gender: m.Gender__c || null,
        emergencyContact: m.EmergencyContact__c || null,
        source: m.Source__c || null,
        registeredBy: m.RegisteredBy__r?.Name || null,
        acceptedBy: m.ApprovedBy__r?.Name || null,
        ticketUrl: m.Status__c === STATUS.ACCEPTED ? `${SITE_URL}/tripTicket?id=${m.Id}` : null,
        billing: billing[m.Id.slice(0, 15)] || null,
      };
    });

    // Collection totals only make sense to someone who can see every invoice.
    let collection = null;
    if (viewer?.isAdmin) {
      const all = Object.values(billing);
      collection = {
        invoiced: all.filter(b => b.status === INVOICE.ISSUED).reduce((s, b) => s + b.total, 0),
        collected: all.reduce((s, b) => s + b.paid, 0),
        outstanding: all.filter(b => b.status === INVOICE.ISSUED).reduce((s, b) => s + b.balance, 0),
        advances: all.filter(b => b.status === INVOICE.DRAFT).reduce((s, b) => s + b.paid, 0),
        invoices: all.filter(b => b.status === INVOICE.ISSUED).length,
        awaitingInvoice: members.filter(m => m.Status__c === STATUS.ACCEPTED
          && billing[m.Id.slice(0, 15)]?.status !== INVOICE.ISSUED).length,
      };
    }

    res.json({
      success: true,
      viewer: viewer
        ? { id: viewer.id, isAdmin: viewer.isAdmin, age: ageFrom(viewer.dob) }
        : null,
      trip: {
        ...shapeTrip(trip),
        registrations: members.length,
        accepted,
        pending: count(STATUS.PENDING),
        rejected: count(STATUS.REJECTED),
        cancelled: count(STATUS.CANCELLED),
        seatsLeft: trip.TotalSeat__c != null ? Math.max(trip.TotalSeat__c - accepted, 0) : null,
        closed: isClosed(trip),
        price: {
          subTotal: money(trip.SubTotal__c),
          gstAmount: money(trip.GSTAmount__c),
          total: money(trip.TotalAmount__c),
          lines: (trip.LineItems__r?.records ?? []).map(shapeLine),
        },
      },
      roster,
      collection,
    });
  } catch (err) {
    console.error('bluemoon trip error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch trip' });
  }
});

function validateTraveller({ gender, age, mobile, email }, { requireMobile }) {
  if (gender && !GENDERS.includes(gender)) return 'Gender must be Male or Female';
  if (age !== undefined && age !== null && age !== '') {
    const n = parseInt(age, 10);
    if (!Number.isFinite(n) || n < 1 || n > 120) return 'Invalid age';
  }
  if (requireMobile && !/^\d{10}$/.test(String(mobile || '').trim())) return 'A 10 digit mobile number is required';
  if (!requireMobile && mobile && !/^\d{10}$/.test(String(mobile).trim())) return 'A 10 digit mobile number is required';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return 'Invalid email';
  return null;
}

const toAge = a => (a === undefined || a === null || a === '' ? null : parseInt(a, 10));

// POST /api/bluemoon/trips/:id/register — a guest books with their own details;
// a signed-in member may book themself (details and age come from Salesforce,
// not the request) or someone else. RegisteredBy__c records who booked.
router.post('/trips/:id/register', async (req, res) => {
  const { id } = req.params;
  const { forSelf, name, mobile, email, age, gender, emergencyContact } = req.body || {};
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid trip id' });

  try {
    const viewer = await resolveViewer(req);
    if (forSelf && !viewer) return res.status(401).json({ success: false, message: 'Please sign in again' });

    const trip = await loadTrip(id);
    if (!trip || trip.Type__c !== 'Trip') return res.status(404).json({ success: false, message: 'Trip not found' });
    if (isClosed(trip)) return res.status(400).json({ success: false, message: 'Registration for this trip is closed' });

    // TripMember__c.Name only accepts letters and spaces (Name_check rule), so
    // a member name like 'Kalaiarasan J.' is cleaned rather than rejected.
    const traveller = forSelf
      ? {
        name: viewer.name.replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim(),
        mobile: viewer.phone || '',
        email: viewer.email || '',
        // Age is derived from the member's date of birth when Salesforce has it.
        age: ageFrom(viewer.dob) ?? toAge(age),
      }
      : {
        name: String(name || '').trim(),
        mobile: String(mobile || '').trim(),
        email: String(email || '').trim(),
        age: toAge(age),
      };

    if (!traveller.name) return res.status(400).json({ success: false, message: 'Name is required' });
    if (!/^[a-zA-Z ]+$/.test(traveller.name)) {
      return res.status(400).json({ success: false, message: 'பெயரில் ஆங்கில எழுத்துகள் மட்டும் (Name: English letters only)' });
    }
    const invalid = validateTraveller({ ...traveller, gender }, { requireMobile: !forSelf });
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    const dupWhere = forSelf
      ? `Member__c = '${viewer.id}'`
      : `MobileNo__c = '${soqlEscape(traveller.mobile)}' AND Name = '${soqlEscape(traveller.name)}'`;
    const [dups, acceptedRows] = await Promise.all([
      sfQuery(`SELECT Id FROM TripMember__c WHERE Event__c = '${id}' AND ${dupWhere}
               AND Status__c NOT IN ('${STATUS.REJECTED}', '${STATUS.CANCELLED}') LIMIT 1`),
      sfQuery(`SELECT Id FROM TripMember__c WHERE Event__c = '${id}' AND Status__c = '${STATUS.ACCEPTED}'`),
    ]);
    if (dups.length) {
      return res.status(409).json({ success: false, message: forSelf ? 'You are already registered for this trip' : 'This person is already registered for this trip' });
    }
    if (trip.TotalSeat__c != null && acceptedRows.length >= trip.TotalSeat__c) {
      return res.status(409).json({ success: false, message: 'All seats are full' });
    }

    const created = await sfCreateRecord('TripMember__c', {
      Name: traveller.name.slice(0, 80),
      Event__c: id,
      MobileNo__c: traveller.mobile || null,
      Email__c: traveller.email || null,
      Age__c: traveller.age,
      Gender__c: gender || null,
      EmergencyContact__c: emergencyContact ? String(emergencyContact).trim().slice(0, 40) : null,
      // Self-bookings link the member; others are matched by email/phone in Salesforce.
      Member__c: forSelf ? viewer.id : null,
      RegisteredBy__c: viewer ? viewer.id : null,
      Source__c: 'Mobile App',
      Status__c: STATUS.PENDING,
    });
    res.json({ success: true, id: created });
  } catch (err) {
    console.error('bluemoon register error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to register') });
  }
});

// GET /api/bluemoon/my-bookings — every booking in the caller's household
// across all trips, with invoice, paid and balance.
router.get('/my-bookings', async (req, res) => {
  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Name, Status__c, Member__c, RegisteredBy__c, RegisteredBy__r.Name, Email__c, MobileNo__c,
              Age__c, Gender__c, EmergencyContact__c, CreatedDate,
              Event__c, Event__r.Name, Event__r.Date__c, Event__r.Destination__c
       FROM TripMember__c
       WHERE ${householdWhere(viewer)}
       ORDER BY CreatedDate DESC`
    );
    const billing = await billingFor(rows.map(r => r.Id));

    res.json({
      success: true,
      bookings: rows.map(r => ({
        id: r.Id,
        name: r.Name,
        status: r.Status__c || STATUS.PENDING,
        isSelf: sameId(r.Member__c, viewer.id),
        registeredBy: r.RegisteredBy__r?.Name || null,
        bookedByMe: sameId(r.RegisteredBy__c, viewer.id),
        mobile: r.MobileNo__c || null,
        email: r.Email__c || null,
        age: r.Age__c ?? null,
        gender: r.Gender__c || null,
        emergencyContact: r.EmergencyContact__c || null,
        tripId: r.Event__c,
        tripName: r.Event__r?.Name || null,
        tripDate: r.Event__r?.Date__c || null,
        destination: r.Event__r?.Destination__c || null,
        ticketUrl: r.Status__c === STATUS.ACCEPTED ? `${SITE_URL}/tripTicket?id=${r.Id}` : null,
        billing: billing[r.Id.slice(0, 15)] || null,
      })),
    });
  } catch (err) {
    console.error('my-bookings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch bookings' });
  }
});

// PATCH /api/bluemoon/bookings/:id — correct a booking's details. A member may
// edit their household's bookings while pending; an admin may edit any. An
// invoice not yet emailed follows the new name/email/mobile.
router.patch('/bookings/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  const { name, mobile, email, age, gender, emergencyContact } = req.body || {};

  const cleanName = String(name || '').trim();
  if (!cleanName || !/^[a-zA-Z ]+$/.test(cleanName)) {
    return res.status(400).json({ success: false, message: 'Name: English letters only' });
  }
  const invalid = validateTraveller({ mobile, email, age, gender }, { requireMobile: false });
  if (invalid) return res.status(400).json({ success: false, message: invalid });

  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Status__c, Member__c, RegisteredBy__c, Email__c, MobileNo__c FROM TripMember__c WHERE Id = '${id}' LIMIT 1`
    );
    const tm = rows[0];
    if (!tm) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (!viewer.isAdmin) {
      if (!isMine(viewer, tm)) return res.status(403).json({ success: false, message: 'Not your booking' });
      if ((tm.Status__c || STATUS.PENDING) !== STATUS.PENDING) {
        return res.status(409).json({ success: false, message: 'Only a pending booking can be changed — contact a Blue Moon admin' });
      }
    }

    const fields = {
      Name: cleanName.slice(0, 80),
      MobileNo__c: mobile ? String(mobile).trim() : null,
      Email__c: email ? String(email).trim() : null,
      Age__c: toAge(age),
      Gender__c: gender || null,
      EmergencyContact__c: emergencyContact ? String(emergencyContact).trim().slice(0, 40) : null,
    };
    await sfUpdateRecord('TripMember__c', id, fields);

    const unsent = await sfQuery(
      `SELECT Id FROM Invoice__c WHERE TripMember__c = '${id}' AND IsSent__c = false AND Status__c != '${INVOICE.CANCELLED}' LIMIT 1`
    );
    if (unsent.length) {
      await sfUpdateRecord('Invoice__c', unsent[0].Id, {
        BillTo__c: fields.Name, Email__c: fields.Email__c, MobileNo__c: fields.MobileNo__c,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon booking edit error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update booking') });
  }
});

// ── Admin: bookings ─────────────────────────────────────────────────────────

// POST /api/bluemoon/admin/members/:id/status — accept, reject or cancel a
// booking. On acceptance the 15-minute job issues the invoice and ticket.
router.post('/admin/members/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  if (![STATUS.ACCEPTED, STATUS.REJECTED, STATUS.CANCELLED].includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be Accepted, Rejected or Cancelled' });
  }

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Name, Status__c, Event__c, Event__r.TotalSeat__c FROM TripMember__c WHERE Id = '${id}' LIMIT 1`
    );
    const tm = rows[0];
    if (!tm) return res.status(404).json({ success: false, message: 'Booking not found' });
    const current = tm.Status__c || STATUS.PENDING;

    const allowed = {
      [STATUS.ACCEPTED]: [STATUS.PENDING],
      [STATUS.REJECTED]: [STATUS.PENDING],
      [STATUS.CANCELLED]: [STATUS.PENDING, STATUS.ACCEPTED],
    }[status];
    if (!allowed.includes(current)) {
      return res.status(409).json({ success: false, message: `${tm.Name} is already ${current}` });
    }

    if (status === STATUS.ACCEPTED && tm.Event__r?.TotalSeat__c != null) {
      const accepted = await sfQuery(
        `SELECT Id FROM TripMember__c WHERE Event__c = '${tm.Event__c}' AND Status__c = '${STATUS.ACCEPTED}'`
      );
      if (accepted.length >= tm.Event__r.TotalSeat__c) {
        return res.status(409).json({ success: false, message: 'All seats are already filled' });
      }
    }

    const fields = { Status__c: status };
    if (status !== STATUS.CANCELLED) {
      fields.ApprovedBy__c = viewer.id; // labelled "Accepted By" in Salesforce
      fields.SignedTime__c = new Date().toISOString();
    }
    await sfUpdateRecord('TripMember__c', id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon status error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update status') });
  }
});

// ── Admin: payments ─────────────────────────────────────────────────────────

// Shared checks for creating and editing a receipt.
function receiptFields({ amount, paymentMode, paymentDate, referenceNo, notes }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) return { error: 'Enter a valid amount' };
  if (paymentMode && !PAYMENT_MODES.includes(paymentMode)) return { error: 'Invalid payment mode' };
  if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return { error: 'paymentDate must be YYYY-MM-DD' };
  return {
    fields: {
      Amount__c: value,
      PaymentMode__c: paymentMode || 'UPI',
      PaymentDate__c: paymentDate || new Date().toISOString().slice(0, 10),
      ReferenceNo__c: referenceNo ? String(referenceNo).trim().slice(0, 100) : null,
      Notes__c: notes ? String(notes).slice(0, 255) : null,
    },
  };
}

// Emails a document now. A failure here must not undo the payment just saved —
// the 15-minute job will pick it up instead.
async function sendNow(recordId) {
  try {
    await sfApexRest('/bluemoon', { action: 'send', recordId });
    return true;
  } catch (err) {
    console.error('bluemoon send error:', err.response?.data || err.message);
    return false;
  }
}

// POST /api/bluemoon/admin/members/:id/receipts — record a payment for a
// booking: an advance before acceptance (held on a Draft invoice) or any
// payment after. The receipt is emailed straight away.
router.post('/admin/members/:id/receipts', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  const { error, fields } = receiptFields(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const tm = (await sfQuery(`SELECT Status__c FROM TripMember__c WHERE Id = '${id}' LIMIT 1`))[0];
    if (!tm) return res.status(404).json({ success: false, message: 'Booking not found' });
    if ([STATUS.REJECTED, STATUS.CANCELLED].includes(tm.Status__c)) {
      return res.status(409).json({ success: false, message: `This booking is ${tm.Status__c}` });
    }

    const invoiceId = await sfApexRest('/bluemoon', { action: 'draft', recordId: id });
    const inv = (await sfQuery(`SELECT BalanceDue__c FROM Invoice__c WHERE Id = '${invoiceId}' LIMIT 1`))[0];
    const balance = money(inv?.BalanceDue__c);
    if (fields.Amount__c > balance + 0.001) {
      return res.status(400).json({ success: false, message: `Amount exceeds the balance due (Rs. ${balance.toFixed(2)})` });
    }

    const receiptId = await sfCreateRecord('Receipt__c', { Invoice__c: invoiceId, ...fields, ReceivedBy__c: viewer.id });
    const emailed = await sendNow(receiptId);
    res.json({ success: true, id: receiptId, emailed });
  } catch (err) {
    console.error('bluemoon receipt error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to record payment') });
  }
});

// PATCH /api/bluemoon/admin/receipts/:id — correct a receipt and email the
// corrected copy.
router.patch('/admin/receipts/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid receipt id' });
  const { error, fields } = receiptFields(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Amount__c, Invoice__r.BalanceDue__c FROM Receipt__c WHERE Id = '${id}' LIMIT 1`
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Receipt not found' });
    const headroom = money(rows[0].Invoice__r?.BalanceDue__c) + money(rows[0].Amount__c);
    if (fields.Amount__c > headroom + 0.001) {
      return res.status(400).json({ success: false, message: `Amount exceeds the balance due (Rs. ${headroom.toFixed(2)})` });
    }

    await sfUpdateRecord('Receipt__c', id, fields);
    const emailed = await sendNow(id);
    res.json({ success: true, emailed });
  } catch (err) {
    console.error('bluemoon receipt edit error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update receipt') });
  }
});

// DELETE /api/bluemoon/admin/receipts/:id — only for a receipt that has not
// been emailed. Once the traveller holds a receipt, correct it instead.
router.delete('/admin/receipts/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid receipt id' });

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const rows = await sfQuery(`SELECT Id, IsSent__c, CreatedDate FROM Receipt__c WHERE Id = '${id}' LIMIT 1`);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Receipt not found' });
    if (rows[0].IsSent__c) {
      return res.status(409).json({ success: false, message: 'This receipt was already emailed — edit it instead' });
    }
    // A new receipt is emailed by a queued job a few seconds after it is saved;
    // deleting it mid-send would leave the traveller holding a dead receipt.
    if (Date.now() - new Date(rows[0].CreatedDate).getTime() < 2 * 60 * 1000) {
      return res.status(409).json({ success: false, message: 'This receipt is being emailed — edit it instead' });
    }
    await sfDeleteRecord('Receipt__c', id);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon receipt delete error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to delete receipt' });
  }
});

// POST /api/bluemoon/admin/send/:id — email an invoice or receipt again, now.
router.post('/admin/send/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    await sfApexRest('/bluemoon', { action: 'send', recordId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon resend error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to send') });
  }
});

// ── Admin: trips and prices ─────────────────────────────────────────────────

// GET /api/bluemoon/admin/trips — every trip, newest first, for the setup screen.
router.get('/admin/trips', async (req, res) => {
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    const [rows, templates] = await Promise.all([
      sfQuery(`SELECT ${TRIP_FIELDS} FROM Event__c WHERE Type__c = 'Trip' ORDER BY Date__c DESC NULLS FIRST`),
      sfQuery(`SELECT Id, Name, IsDefault__c FROM PriceTemplate__c WHERE IsActive__c = true ORDER BY Name`),
    ]);
    res.json({
      success: true,
      trips: rows.map(t => ({ ...shapeTrip(t), total: money(t.TotalAmount__c) })),
      templates: templates.map(t => ({ id: t.Id, name: t.Name, isDefault: t.IsDefault__c === true })),
    });
  } catch (err) {
    console.error('bluemoon admin trips error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch trips' });
  }
});

function tripFields(body, { creating }) {
  const out = {};
  const str = (k, f, max = 255) => {
    if (body[k] !== undefined) out[f] = body[k] ? String(body[k]).trim().slice(0, max) : null;
  };
  str('name', 'Name', 80);
  str('nameEnglish', 'NameEnglish__c');
  str('destination', 'Destination__c');
  str('venue', 'Venue__c');
  str('eventCode', 'EventCode__c');
  if (body.date !== undefined) {
    if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return { error: 'Date must be YYYY-MM-DD' };
    out.Date__c = body.date || null;
  }
  for (const [k, f] of [['departureTime', 'DepartureTime__c'], ['returnTime', 'ReturnTime__c']]) {
    if (body[k] !== undefined) {
      const iso = istToIso(body[k]);
      if (iso === undefined) return { error: 'Times must be YYYY-MM-DD HH:MM' };
      out[f] = iso;
    }
  }
  if (body.totalSeats !== undefined) {
    const n = body.totalSeats === '' || body.totalSeats === null ? null : parseInt(body.totalSeats, 10);
    if (n !== null && (!Number.isFinite(n) || n < 1)) return { error: 'Seats must be a positive number' };
    out.TotalSeat__c = n;
  }
  if (body.isActive !== undefined) out.IsActiveTrip__c = body.isActive === true;
  if (body.priceTemplateId !== undefined) {
    if (body.priceTemplateId && !validId(body.priceTemplateId)) return { error: 'Invalid price template' };
    out.PriceTemplate__c = body.priceTemplateId || null;
  }
  if (creating) {
    if (!out.Name) return { error: 'Trip name is required' };
    out.Type__c = 'Trip';
    out.Organizer__c = 'Blue Moon - UPR';
  }
  return { fields: out };
}

// POST /api/bluemoon/admin/trips — create a trip. Its price lines are copied
// from the chosen (or default) price template by EventTrigger.
router.post('/admin/trips', async (req, res) => {
  const { error, fields } = tripFields(req.body || {}, { creating: true });
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    const id = await sfCreateRecord('Event__c', fields);
    res.json({ success: true, id });
  } catch (err) {
    console.error('bluemoon trip create error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to create trip') });
  }
});

// PATCH /api/bluemoon/admin/trips/:id — edit trip details or open/close it.
router.patch('/admin/trips/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid trip id' });
  const { error, fields } = tripFields(req.body || {}, { creating: false });
  if (error) return res.status(400).json({ success: false, message: error });
  if (fields.Name === null) return res.status(400).json({ success: false, message: 'Trip name is required' });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    await sfUpdateRecord('Event__c', id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon trip edit error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update trip') });
  }
});

function lineFields(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Item name is required' };
  const price = Math.round(Number(body.price) * 100) / 100;
  if (!Number.isFinite(price) || price < 0) return { error: 'Enter a valid price' };
  const qty = body.quantity === undefined || body.quantity === '' ? 1 : Number(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { error: 'Enter a valid quantity' };
  const gst = body.gstApplicable === true;
  const pct = gst ? Number(body.gstPercent) : null;
  if (gst && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return { error: 'Enter a GST % between 0 and 100' };
  return {
    fields: {
      Name: name.slice(0, 80),
      Price__c: price,
      Quantity__c: qty,
      IsGSTApplicable__c: gst,
      GSTPercent__c: pct,
      Order__c: body.order === undefined || body.order === '' || body.order === null ? null : parseInt(body.order, 10),
      Description__c: body.description ? String(body.description).slice(0, 255) : null,
    },
  };
}

// POST /api/bluemoon/admin/trips/:id/lines — add a price item to a trip.
router.post('/admin/trips/:id/lines', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid trip id' });
  const { error, fields } = lineFields(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    const lineId = await sfCreateRecord('EventLineItem__c', { Event__c: id, ...fields });
    res.json({ success: true, id: lineId });
  } catch (err) {
    console.error('bluemoon line create error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to add price item') });
  }
});

// PATCH /api/bluemoon/admin/lines/:id — edit a price item. Invoices already
// raised keep their own snapshot and are not changed.
router.patch('/admin/lines/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  const { error, fields } = lineFields(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    await sfUpdateRecord('EventLineItem__c', id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon line edit error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update price item') });
  }
});

// DELETE /api/bluemoon/admin/lines/:id — remove a price item.
router.delete('/admin/lines/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;
    await sfDeleteRecord('EventLineItem__c', id);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon line delete error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to delete price item') });
  }
});

module.exports = router;
