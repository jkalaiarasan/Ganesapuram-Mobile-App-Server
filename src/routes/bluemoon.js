const express = require('express');
const router = express.Router();
const { sfQuery, soqlEscape, sfCreateRecord, sfUpdateRecord, sfDeleteRecord } = require('../services/salesforce');

// Blue Moon trips: pricing, registration, bookings, and the admin desk.
//
// Visibility rule, enforced here rather than in the app:
//   - everyone sees a trip's roster (name + status),
//   - invoice/receipt amounts are returned only to a Blue Moon admin, or to the
//     logged-in member who is the traveller or who registered the booking.
// Travellers who are not members get their invoice and receipts by email only.

const SITE_URL = 'https://account-dev-ed.develop.my.site.com/upr/apex';
const STATUS = { PENDING: 'Pending Approval', ACCEPTED: 'Accepted', REJECTED: 'Rejected' };
const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque'];
const GENDERS = ['Male', 'Female', 'Other'];

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(id);
}

// 15- and 18-char ids name the same record; compare on the 15-char prefix.
function sameId(a, b) {
  return !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
}

// Identifies the caller from the app's session headers. Returns null for a
// guest or a stale session — never throws for a bad token.
async function resolveViewer(req) {
  const memberId = req.headers['x-member-id'];
  const sessionToken = req.headers['x-session-token'];
  if (!validId(memberId) || !sessionToken) return null;

  const rows = await sfQuery(
    `SELECT Id, Name, Email__c, Phone__c, SessionToken__c, IsBlueMoonAdmin__c
     FROM Member__c WHERE Id = '${memberId}' AND Is_Approved__c = true LIMIT 1`
  );
  const m = rows[0];
  if (!m || m.SessionToken__c !== sessionToken) return null;
  return { id: m.Id, name: m.Name, email: m.Email__c, phone: m.Phone__c, isAdmin: m.IsBlueMoonAdmin__c === true };
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

const money = v => (typeof v === 'number' ? v : 0);

function shapeLine(l) {
  return {
    name: l.Name,
    description: l.Description__c || null,
    price: money(l.Price__c),
    quantity: l.Quantity__c ?? 1,
    gstApplicable: l.IsGSTApplicable__c === true,
    gstPercent: l.GSTPercent__c ?? 0,
    gstAmount: money(l.GSTAmount__c),
    total: money(l.TotalAmount__c),
  };
}

// Invoices (with receipts) for a set of trip members, keyed by trip member id.
async function billingFor(tripMemberIds) {
  if (!tripMemberIds.length) return {};
  const ids = tripMemberIds.map(id => `'${id}'`).join(',');
  const invoices = await sfQuery(
    `SELECT Id, Name, TripMember__c, InvoiceDate__c, SubTotal__c, GSTAmount__c, TotalAmount__c,
            AmountPaid__c, BalanceDue__c, PaymentStatus__c, IsSent__c,
            (SELECT Id, Name, Amount__c, PaymentDate__c, PaymentMode__c, ReferenceNo__c, Notes__c, IsSent__c,
                    ReceivedBy__r.Name, CreatedDate
             FROM Receipts__r ORDER BY CreatedDate ASC)
     FROM Invoice__c WHERE TripMember__c IN (${ids})`
  );
  const out = {};
  for (const inv of invoices) {
    out[inv.TripMember__c.slice(0, 15)] = {
      invoiceId: inv.Id,
      invoiceNumber: inv.Name,
      invoiceDate: inv.InvoiceDate__c || null,
      subTotal: money(inv.SubTotal__c),
      gstAmount: money(inv.GSTAmount__c),
      total: money(inv.TotalAmount__c),
      paid: money(inv.AmountPaid__c),
      balance: money(inv.BalanceDue__c),
      paymentStatus: inv.PaymentStatus__c || 'Unpaid',
      emailed: inv.IsSent__c === true,
      invoiceUrl: `${SITE_URL}/tripInvoice?id=${inv.Id}`,
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

async function loadTrip(id) {
  const rows = await sfQuery(
    `SELECT Id, Name, NameEnglish__c, Date__c, Destination__c, Venue__c, DepartureTime__c, ReturnTime__c,
            TotalSeat__c, EventCode__c, Organizer__c, Type__c, SubTotal__c, GSTAmount__c, TotalAmount__c,
            (SELECT Name, Description__c, Price__c, Quantity__c, IsGSTApplicable__c, GSTPercent__c,
                    GSTAmount__c, TotalAmount__c
             FROM LineItems__r ORDER BY Order__c ASC NULLS LAST, Name)
     FROM Event__c WHERE Id = '${id}' LIMIT 1`
  );
  return rows[0] || null;
}

function isClosed(trip) {
  if (!trip.Date__c) return false;
  const today = new Date().toISOString().slice(0, 10);
  return trip.Date__c < today;
}

// GET /api/bluemoon/trips/:id — full trip detail. The roster is public; each
// entry carries `billing` only when the caller may see it.
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

    const mine = m => !!viewer && (sameId(m.Member__c, viewer.id) || sameId(m.RegisteredBy__c, viewer.id));
    const visible = members.filter(m => viewer?.isAdmin || mine(m));
    const billing = await billingFor(visible.map(m => m.Id));

    const accepted = members.filter(m => m.Status__c === STATUS.ACCEPTED).length;
    const pending = members.filter(m => (m.Status__c || STATUS.PENDING) === STATUS.PENDING).length;
    const rejected = members.filter(m => m.Status__c === STATUS.REJECTED).length;

    const roster = members.map(m => {
      const canSee = viewer?.isAdmin || mine(m);
      const entry = {
        id: m.Id,
        name: m.Name,
        status: m.Status__c || STATUS.PENDING,
        isMine: mine(m),
        isSelf: !!viewer && sameId(m.Member__c, viewer.id),
        isMember: !!m.Member__c,
      };
      if (!canSee) return entry;
      return {
        ...entry,
        mobile: m.MobileNo__c || null,
        email: m.Email__c || null,
        age: m.Age__c ?? null,
        gender: m.Gender__c || null,
        emergencyContact: m.EmergencyContact__c || null,
        source: m.Source__c || null,
        registeredBy: m.RegisteredBy__r?.Name || null,
        approvedBy: m.ApprovedBy__r?.Name || null,
        ticketUrl: m.Status__c === STATUS.ACCEPTED ? `${SITE_URL}/tripTicket?id=${m.Id}` : null,
        billing: billing[m.Id.slice(0, 15)] || null,
      };
    });

    // Collection totals only make sense to someone who can see every invoice.
    let collection = null;
    if (viewer?.isAdmin) {
      const all = Object.values(billing);
      collection = {
        invoiced: all.reduce((s, b) => s + b.total, 0),
        collected: all.reduce((s, b) => s + b.paid, 0),
        outstanding: all.reduce((s, b) => s + b.balance, 0),
        invoices: all.length,
        awaitingInvoice: members.filter(m => m.Status__c === STATUS.ACCEPTED && !billing[m.Id.slice(0, 15)]).length,
      };
    }

    res.json({
      success: true,
      viewer: viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null,
      trip: {
        id: trip.Id,
        name: trip.Name,
        nameEnglish: trip.NameEnglish__c || null,
        date: trip.Date__c || null,
        destination: trip.Destination__c || null,
        venue: trip.Venue__c || null,
        departureTime: trip.DepartureTime__c || null,
        returnTime: trip.ReturnTime__c || null,
        eventCode: trip.EventCode__c || null,
        organizer: trip.Organizer__c || null,
        totalSeats: trip.TotalSeat__c ?? null,
        registrations: members.length,
        accepted,
        pending,
        rejected,
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

// POST /api/bluemoon/trips/:id/register — a guest registers with their own
// details; a signed-in member may register themself (details come from
// Salesforce, not the request) or someone else. RegisteredBy__c records who
// made the booking either way.
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

    const traveller = forSelf
      // TripMember__c.Name only accepts letters and spaces (Name_check rule), so
      // a member name like 'Kalaiarasan J.' is cleaned rather than rejected.
      ? { name: viewer.name.replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim(), mobile: viewer.phone || '', email: viewer.email || '' }
      : { name: String(name || '').trim(), mobile: String(mobile || '').trim(), email: String(email || '').trim() };

    if (!traveller.name) return res.status(400).json({ success: false, message: 'Name is required' });
    if (!/^[a-zA-Z ]+$/.test(traveller.name)) {
      return res.status(400).json({ success: false, message: 'பெயரில் ஆங்கில எழுத்துகள் மட்டும் (Name: English letters only)' });
    }
    if (!forSelf && !/^\d{10}$/.test(traveller.mobile)) {
      return res.status(400).json({ success: false, message: 'A 10 digit mobile number is required' });
    }
    if (gender && !GENDERS.includes(gender)) return res.status(400).json({ success: false, message: 'Invalid gender' });
    const ageNum = age === undefined || age === null || age === '' ? null : parseInt(age, 10);
    if (ageNum !== null && (!Number.isFinite(ageNum) || ageNum < 1 || ageNum > 120)) {
      return res.status(400).json({ success: false, message: 'Invalid age' });
    }

    const dupWhere = forSelf
      ? `Member__c = '${viewer.id}'`
      : `MobileNo__c = '${soqlEscape(traveller.mobile)}' AND Name = '${soqlEscape(traveller.name)}'`;
    const [dups, acceptedRows] = await Promise.all([
      sfQuery(`SELECT Id FROM TripMember__c WHERE Event__c = '${id}' AND ${dupWhere} LIMIT 1`),
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
      Age__c: ageNum,
      Gender__c: gender || null,
      EmergencyContact__c: emergencyContact ? String(emergencyContact).trim().slice(0, 40) : null,
      Member__c: forSelf ? viewer.id : null,
      RegisteredBy__c: viewer ? viewer.id : null,
      Source__c: 'Mobile App',
      Status__c: STATUS.PENDING,
    });
    res.json({ success: true, id: created });
  } catch (err) {
    console.error('bluemoon register error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to register' });
  }
});

// GET /api/bluemoon/my-bookings — every booking where the caller travels or
// registered someone, across all trips, with billing.
router.get('/my-bookings', async (req, res) => {
  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Name, Status__c, Member__c, RegisteredBy__c, CreatedDate,
              Event__c, Event__r.Name, Event__r.Date__c, Event__r.Destination__c
       FROM TripMember__c
       WHERE Member__c = '${viewer.id}' OR RegisteredBy__c = '${viewer.id}'
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

// POST /api/bluemoon/admin/members/:id/status — approve or reject a booking.
// The 15-minute Salesforce job then raises the invoice and emails the ticket.
router.post('/admin/members/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  if (![STATUS.ACCEPTED, STATUS.REJECTED].includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be Accepted or Rejected' });
  }

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const rows = await sfQuery(
      `SELECT Id, Name, Status__c, Event__c, Event__r.TotalSeat__c FROM TripMember__c WHERE Id = '${id}' LIMIT 1`
    );
    const tm = rows[0];
    if (!tm) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (tm.Status__c === STATUS.ACCEPTED || tm.Status__c === STATUS.REJECTED) {
      return res.status(409).json({ success: false, message: `${tm.Name} has already been ${tm.Status__c}` });
    }

    if (status === STATUS.ACCEPTED && tm.Event__r?.TotalSeat__c != null) {
      const accepted = await sfQuery(
        `SELECT Id FROM TripMember__c WHERE Event__c = '${tm.Event__c}' AND Status__c = '${STATUS.ACCEPTED}'`
      );
      if (accepted.length >= tm.Event__r.TotalSeat__c) {
        return res.status(409).json({ success: false, message: 'All seats are already filled' });
      }
    }

    await sfUpdateRecord('TripMember__c', id, {
      Status__c: status,
      ApprovedBy__c: viewer.id,
      SignedTime__c: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon status error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// Salesforce validation rules speak for themselves; pass their message through
// instead of a generic failure.
function sfErrorMessage(err, fallback) {
  const first = Array.isArray(err.response?.data) ? err.response.data[0] : null;
  return first?.errorCode === 'FIELD_CUSTOM_VALIDATION_EXCEPTION' ? first.message : fallback;
}

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

// POST /api/bluemoon/admin/invoices/:id/receipts — record a payment. Only
// allowed once the invoice has been emailed; the receipt itself is emailed by
// the 15-minute Salesforce job.
router.post('/admin/invoices/:id/receipts', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid invoice id' });
  const { error, fields } = receiptFields(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const rows = await sfQuery(`SELECT Id, BalanceDue__c, IsSent__c FROM Invoice__c WHERE Id = '${id}' LIMIT 1`);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (!rows[0].IsSent__c) {
      return res.status(409).json({ success: false, message: 'Invoice not sent yet — add the payment after it is emailed' });
    }
    const balance = money(rows[0].BalanceDue__c);
    if (fields.Amount__c > balance + 0.001) {
      return res.status(400).json({ success: false, message: `Amount exceeds the balance due (Rs. ${balance.toFixed(2)})` });
    }

    const receiptId = await sfCreateRecord('Receipt__c', { Invoice__c: id, ...fields, ReceivedBy__c: viewer.id });
    res.json({ success: true, id: receiptId });
  } catch (err) {
    console.error('bluemoon receipt error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to record receipt') });
  }
});

// PATCH /api/bluemoon/admin/receipts/:id — correct a receipt. If it was
// already emailed, Salesforce (ReceiptTrigger) queues the corrected copy.
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
    res.json({ success: true });
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

    const rows = await sfQuery(`SELECT Id, IsSent__c FROM Receipt__c WHERE Id = '${id}' LIMIT 1`);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Receipt not found' });
    if (rows[0].IsSent__c) {
      return res.status(409).json({ success: false, message: 'This receipt was already emailed — edit it instead' });
    }
    await sfDeleteRecord('Receipt__c', id);
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon receipt delete error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to delete receipt' });
  }
});

// PATCH /api/bluemoon/admin/members/:id — correct a booking's details. An
// invoice not yet emailed is kept in step so it goes to the right address.
router.patch('/admin/members/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  const { name, mobile, email, age, gender, emergencyContact } = req.body || {};

  const cleanName = String(name || '').trim();
  if (!cleanName || !/^[a-zA-Z ]+$/.test(cleanName)) {
    return res.status(400).json({ success: false, message: 'Name: English letters only' });
  }
  if (mobile && !/^\d{10}$/.test(String(mobile).trim())) {
    return res.status(400).json({ success: false, message: 'A 10 digit mobile number is required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ success: false, message: 'Invalid email' });
  }
  if (gender && !GENDERS.includes(gender)) return res.status(400).json({ success: false, message: 'Invalid gender' });
  const ageNum = age === undefined || age === null || age === '' ? null : parseInt(age, 10);
  if (ageNum !== null && (!Number.isFinite(ageNum) || ageNum < 1 || ageNum > 120)) {
    return res.status(400).json({ success: false, message: 'Invalid age' });
  }

  try {
    const viewer = await requireViewer(req, res, { admin: true });
    if (!viewer) return;

    const fields = {
      Name: cleanName.slice(0, 80),
      MobileNo__c: mobile ? String(mobile).trim() : null,
      Email__c: email ? String(email).trim() : null,
      Age__c: ageNum,
      Gender__c: gender || null,
      EmergencyContact__c: emergencyContact ? String(emergencyContact).trim().slice(0, 40) : null,
    };
    await sfUpdateRecord('TripMember__c', id, fields);

    const unsent = await sfQuery(
      `SELECT Id FROM Invoice__c WHERE TripMember__c = '${id}' AND IsSent__c = false LIMIT 1`
    );
    if (unsent.length) {
      await sfUpdateRecord('Invoice__c', unsent[0].Id, {
        BillTo__c: fields.Name, Email__c: fields.Email__c, MobileNo__c: fields.MobileNo__c,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('bluemoon member edit error:', err.response?.data || err.message);
    res.status(400).json({ success: false, message: sfErrorMessage(err, 'Failed to update booking') });
  }
});

module.exports = router;
